import https from "https";
import http from "http";

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

function makeRequest(targetUrl, type, res, depth = 0) {
  if (depth > 5) return res.status(500).json({ error: "Too many redirects" });

  const parsedUrl = new URL(targetUrl);
  const lib = parsedUrl.protocol === "https:" ? https : http;

  const options = {
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80),
    path: parsedUrl.pathname + parsedUrl.search,
    method: "GET",
    agent: parsedUrl.protocol === "https:" ? httpsAgent : undefined,
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; PodcastLearner/1.0)",
      "Accept": type === "audio"
        ? "audio/mpeg, audio/*, */*"
        : "application/rss+xml, application/xml, text/xml, */*",
    },
  };

  const proxyReq = lib.request(options, (proxyRes) => {
    if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
      const redirectUrl = new URL(proxyRes.headers.location, targetUrl).toString();
      return makeRequest(redirectUrl, type, res, depth + 1);
    }

    if (proxyRes.statusCode !== 200) {
      return res.status(proxyRes.statusCode).json({ error: "Upstream " + proxyRes.statusCode });
    }

    const contentType = proxyRes.headers["content-type"] || (type === "audio" ? "audio/mpeg" : "application/xml");
    res.setHeader("Content-Type", contentType);
    if (proxyRes.headers["content-length"]) {
      res.setHeader("Content-Length", proxyRes.headers["content-length"]);
    }
    res.status(200);
    proxyRes.pipe(res);
  });

  proxyReq.on("error", (e) => res.status(500).json({ error: e.message, target: targetUrl }));
  proxyReq.setTimeout(55000, () => { proxyReq.destroy(); res.status(504).json({ error: "Timeout" }); });
  proxyReq.end();
}

export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  const { url, type } = req.query;
  if (!url) return res.status(400).json({ error: "Missing url" });

  let targetUrl;
  try {
    targetUrl = decodeURIComponent(url);
    new URL(targetUrl);
  } catch {
    return res.status(400).json({ error: "Invalid URL" });
  }

  makeRequest(targetUrl, type, res);
}
