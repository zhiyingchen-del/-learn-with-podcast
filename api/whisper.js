import https from "https";
import http from "http";

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

// Download audio in chunks using Range requests
function downloadAudioRange(url, start, end) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    function doRequest(targetUrl, depth) {
      if (depth > 5) return reject(new Error("Too many redirects"));
      const parsed = new URL(targetUrl);
      const lib = parsed.protocol === "https:" ? https : http;
      const headers = {
        "User-Agent": "Mozilla/5.0 (compatible; PodcastLearner/1.0)",
      };
      if (end !== undefined) {
        headers["Range"] = `bytes=${start}-${end}`;
      }
      const opts = {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: "GET",
        agent: parsed.protocol === "https:" ? httpsAgent : undefined,
        headers,
        timeout: 55000,
      };
      const req = lib.request(opts, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          return doRequest(new URL(response.headers.location, targetUrl).toString(), depth + 1);
        }
        if (response.statusCode !== 200 && response.statusCode !== 206) {
          return reject(new Error("Download failed: HTTP " + response.statusCode));
        }
        // Get content-length for full file size info
        const contentLength = response.headers["content-length"];
        const contentRange = response.headers["content-range"];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve({
          buffer: Buffer.concat(chunks),
          contentLength: parseInt(contentLength) || null,
          contentRange,
        }));
        response.on("error", reject);
      });
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("Download timeout")); });
      req.end();
    }
    doRequest(url, 0);
  });
}

function callWhisper(apiKey, audioBuffer, langCode, timeOffset) {
  return new Promise((resolve, reject) => {
    const boundary = "WhisperBoundary" + Date.now();
    const textParts = [
      "--" + boundary + "\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\nwhisper-1",
      "--" + boundary + "\r\nContent-Disposition: form-data; name=\"language\"\r\n\r\n" + langCode,
      "--" + boundary + "\r\nContent-Disposition: form-data; name=\"response_format\"\r\n\r\nverbose_json",
      "--" + boundary + "\r\nContent-Disposition: form-data; name=\"timestamp_granularities[]\"\r\n\r\nsegment",
    ].join("\r\n") + "\r\n";

    const fileHeader = "--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"audio.mp3\"\r\nContent-Type: audio/mpeg\r\n\r\n";
    const fileFooter = "\r\n--" + boundary + "--\r\n";
    const formBody = Buffer.concat([
      Buffer.from(textParts),
      Buffer.from(fileHeader),
      audioBuffer,
      Buffer.from(fileFooter),
    ]);

    const opts = {
      hostname: "api.openai.com",
      path: "/v1/audio/transcriptions",
      method: "POST",
      headers: {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "multipart/form-data; boundary=" + boundary,
        "Content-Length": formBody.length,
      },
    };

    const req = https.request(opts, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString());
          if (json.error) return reject(new Error(json.error.message || "Whisper error"));
          // Offset timestamps
          const segments = (json.segments || []).map((seg, i) => ({
            id: i,
            start: seg.start + timeOffset,
            end: seg.end + timeOffset,
            text: seg.text.trim(),
          }));
          resolve(segments);
        } catch (e) {
          reject(new Error("Failed to parse Whisper response"));
        }
      });
      response.on("error", reject);
    });
    req.on("error", reject);
    req.write(formBody);
    req.end();
  });
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method === "GET") return res.status(200).json({ status: "ok", message: "Whisper proxy ready" });
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let bodyStr;
  try { bodyStr = await readBody(req); }
  catch (e) { return res.status(400).json({ error: "Failed to read body: " + e.message }); }

  let audioUrl, openaiKey, language;
  try { ({ audioUrl, openaiKey, language } = JSON.parse(bodyStr)); }
  catch { return res.status(400).json({ error: "Invalid JSON" }); }

  if (!audioUrl || !openaiKey) {
    return res.status(400).json({ error: "Missing audioUrl or openaiKey" });
  }

  const langCode = language === "fr" ? "fr" : "en";
  // 20MB chunks — safe for Whisper's 25MB limit
  const CHUNK_SIZE = 20 * 1024 * 1024;

  try {
    // First: get file size with HEAD-like request (download first byte)
    const firstChunk = await downloadAudioRange(audioUrl, 0, 0);
    let totalSize = firstChunk.contentLength;

    // Parse total size from content-range if available
    if (firstChunk.contentRange) {
      const match = firstChunk.contentRange.match(/\/(\d+)$/);
      if (match) totalSize = parseInt(match[1]);
    }

    let allSegments = [];

    if (!totalSize || totalSize <= CHUNK_SIZE) {
      // File is small enough — download all at once
      const { buffer } = await downloadAudioRange(audioUrl, 0, undefined);
      allSegments = await callWhisper(openaiKey, buffer, langCode, 0);
    } else {
      // Large file — process in chunks
      // Estimate: MP3 at 128kbps ≈ 1MB per minute
      // So 20MB chunk ≈ 20 minutes of audio
      const numChunks = Math.ceil(totalSize / CHUNK_SIZE);
      const minutesPerChunk = 20; // approximate

      for (let i = 0; i < numChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min((i + 1) * CHUNK_SIZE - 1, totalSize - 1);
        const timeOffset = i * minutesPerChunk * 60;

        const { buffer } = await downloadAudioRange(audioUrl, start, end);
        const segments = await callWhisper(openaiKey, buffer, langCode, timeOffset);

        // Re-index segment IDs
        const offset = allSegments.length;
        allSegments.push(...segments.map(s => ({ ...s, id: s.id + offset })));
      }
    }

    return res.status(200).json({ segments: allSegments });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
