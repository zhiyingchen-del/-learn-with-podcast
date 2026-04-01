import https from "https";
import http from "http";

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

function makeRequest(targetUrl, reqHeaders, res, depth = 0) {
  if (depth > 5) return res.status(500).json({ error: "Too many redirects" });

  const parsed = new URL(targetUrl);
  const lib = parsed.protocol === "https:" ? https : http;

  const headers = {
    "User-Agent": "Mozilla/5.0 (compatible; PodcastLearner/1.0)",
    "Accept": "*/*",
  };

  // Forward Range header for audio seeking
  if (reqHeaders.range) {
    headers["Range"] = reqHeaders.range;
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

  const proxyReq = lib.request(opts, (proxyRes) => {
    // Handle redirects
    if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
      const redirectUrl = new URL(proxyRes.headers.location, targetUrl).toString();
      return makeRequest(redirectUrl, reqHeaders, res, depth + 1);
    }

    // Forward relevant headers
    const forwardHeaders = [
      "content-type", "content-length", "content-range",
      "accept-ranges", "last-modified", "etag",
    ];
    forwardHeaders.forEach(h => {
      if (proxyRes.headers[h]) res.setHeader(h, proxyRes.headers[h]);
    });

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Accept-Ranges", "bytes");

    // Stream response directly to client
    res.status(proxyRes.statusCode);
    proxyRes.pipe(res);
  });

  proxyReq.on("error", (e) => {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  });
  proxyReq.on("timeout", () => {
    proxyReq.destroy();
    if (!res.headersSent) res.status(504).json({ error: "Timeout" });
  });
  proxyReq.end();
}

export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");

  if (req.method === "OPTIONS") return res.status(200).end();

  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Missing url" });

  let targetUrl;
  try {
    targetUrl = decodeURIComponent(url);
    new URL(targetUrl);
  } catch {
    return res.status(400).json({ error: "Invalid URL" });
  }

  makeRequest(targetUrl, req.headers, res);
}
