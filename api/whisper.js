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

function downloadAudio(url) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    function doRequest(targetUrl, depth) {
      if (depth > 5) return reject(new Error("Too many redirects"));
      const parsed = new URL(targetUrl);
      const lib = parsed.protocol === "https:" ? https : http;
      const opts = {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: "GET",
        agent: parsed.protocol === "https:" ? httpsAgent : undefined,
        headers: { "User-Agent": "Mozilla/5.0 (compatible; PodcastLearner/1.0)" },
        timeout: 55000,
      };
      const req = lib.request(opts, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          return doRequest(new URL(response.headers.location, targetUrl).toString(), depth + 1);
        }
        if (response.statusCode !== 200) {
          return reject(new Error("音訊下載失敗: HTTP " + response.statusCode));
        }
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve(Buffer.concat(chunks)));
        response.on("error", reject);
      });
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("下載逾時，音訊檔案可能太大")); });
      req.end();
    }
    doRequest(url, 0);
  });
}

function callWhisper(apiKey, boundary, formBody) {
  return new Promise((resolve, reject) => {
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
          if (json.error) reject(new Error(json.error.message || "Whisper 錯誤"));
          else resolve(json);
        } catch (e) {
          reject(new Error("無法解析 Whisper 回應"));
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
  try {
    bodyStr = await readBody(req);
  } catch (e) {
    return res.status(400).json({ error: "Failed to read request body: " + e.message });
  }

  let audioUrl, openaiKey, language;
  try {
    ({ audioUrl, openaiKey, language } = JSON.parse(bodyStr));
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  if (!audioUrl || !openaiKey) {
    return res.status(400).json({ error: "Missing audioUrl or openaiKey" });
  }

  try {
    const audioBuffer = await downloadAudio(audioUrl);

    const boundary = "WhisperBoundary" + Date.now();
    const langCode = language === "fr" ? "fr" : "en";

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

    const result = await callWhisper(openaiKey, boundary, formBody);
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
