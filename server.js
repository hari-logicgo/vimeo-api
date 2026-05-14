const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");
const { Parser } = require("m3u8-parser");

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;

function isValidVimeoUrl(url) {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === "vimeo.com" ||
      parsed.hostname === "www.vimeo.com" ||
      parsed.hostname === "player.vimeo.com"
    );
  } catch {
    return false;
  }
}
function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return null;

  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;

  return `${mins}:${String(secs).padStart(2, "0")}`;
}
function extractMasterHlsUrl(configJson) {
  const hls = configJson?.request?.files?.hls;

  if (!hls) {
    throw new Error("HLS not found");
  }

  const defaultCdn = hls.default_cdn;
  const cdns = hls.cdns || {};

  if (defaultCdn && cdns[defaultCdn]?.url) {
    return cdns[defaultCdn].url;
  }

  for (const cdnName of Object.keys(cdns)) {
    if (cdns[cdnName]?.url) {
      return cdns[cdnName].url;
    }
  }

  throw new Error("Master HLS URL not found");
}

async function waitForVimeoConfig(page, timeout = 15000) {
  const response = await page.waitForResponse(
    async (res) => {
      const url = res.url();
      const contentType = res.headers()["content-type"] || "";

      return (
        url.includes("player.vimeo.com/video/") &&
        url.includes("/config") &&
        res.status() === 200 &&
        contentType.includes("application/json")
      );
    },
    { timeout }
  );

  return await response.json();
}

async function getVimeoConfig(videoPageUrl) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    });

    const page = await context.newPage();

    const configPromise = waitForVimeoConfig(page, 12000);

    await page.goto(videoPageUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    try {
      return await configPromise;
    } catch {
      const reloadConfigPromise = waitForVimeoConfig(page, 15000);

      await page.reload({
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });

      return await reloadConfigPromise;
    }
  } finally {
    await browser.close();
  }
}

// async function getResolutionWiseVideos(masterHlsUrl) {
//   const response = await fetch(masterHlsUrl, {
//     headers: {
//       "User-Agent":
//         "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
//       Accept: "*/*",
//     },
//   });

//   if (!response.ok) {
//     throw new Error("Failed to fetch HLS playlist");
//   }

//   const playlistText = await response.text();

//   const parser = new Parser();
//   parser.push(playlistText);
//   parser.end();

//   const playlists = parser.manifest.playlists || [];

//   if (!playlists.length) {
//     throw new Error("No resolution playlists found");
//   }

//   const videos = {};

//   const sorted = playlists
//     .map((playlist) => {
//       const attrs = playlist.attributes || {};
//       const resolution = attrs.RESOLUTION || {};
//       const height = resolution.height || null;

//       return {
//         quality: height ? `${height}p` : null,
//         bandwidth: attrs.BANDWIDTH || 0,
//         url: new URL(playlist.uri, masterHlsUrl).href,
//       };
//     })
//     .filter((item) => item.quality)
//     .sort((a, b) => b.bandwidth - a.bandwidth);

//   for (const item of sorted) {
//     if (!videos[item.quality]) {
//       videos[item.quality] = item.url;
//     }
//   }

//   return videos;
// }
async function getResolutionWiseVideos(masterHlsUrl) {
  const response = await fetch(masterHlsUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      Accept: "*/*",
    },
  });

  if (!response.ok) {
    throw new Error("Failed to fetch HLS playlist");
  }

  const playlistText = await response.text();

  const parser = new Parser();
  parser.push(playlistText);
  parser.end();

  const playlists = parser.manifest.playlists || [];

  if (!playlists.length) {
    throw new Error("No resolution playlists found");
  }

  const videos = {};

  const sorted = playlists
    .map((playlist) => {
      const attrs = playlist.attributes || {};
      const resolution = attrs.RESOLUTION || {};
      const height = resolution.height || null;
      const width = resolution.width || null;

      return {
        quality: height ? `${height}p` : null,
        width,
        height,
        bandwidth: attrs.BANDWIDTH || 0,
        video_url: new URL(playlist.uri, masterHlsUrl).href,
      };
    })
    .filter((item) => item.quality)
    .sort((a, b) => b.bandwidth - a.bandwidth);

  for (const item of sorted) {
    if (!videos[item.quality]) {
      videos[item.quality] = {
        video_url: item.video_url,
        resolution: item.quality,
        width: item.width,
        height: item.height,
      };
    }
  }

  return videos;
}

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Vimeo API is running",
    data: null,
  });
});

app.post("/extract", async (req, res) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({
        success: false,
        message: "url is required",
        data: null,
      });
    }

    if (!isValidVimeoUrl(url)) {
      return res.status(400).json({
        success: false,
        message: "Only Vimeo URL is allowed",
        data: null,
      });
    }

    const configJson = await getVimeoConfig(url);
    const masterHlsUrl = extractMasterHlsUrl(configJson);
    const videos = await getResolutionWiseVideos(masterHlsUrl);

    return res.json({
      success: true,
      message: "Video URL extracted successfully",
      data: {
        title: configJson?.video?.title || null,
        duration_formatted: formatDuration(configJson?.video?.duration),
        thumbnail_url: configJson?.video?.thumbnail_url || null,
        videos,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
      data: null,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
