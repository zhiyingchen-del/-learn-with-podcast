import https from "https";
import http from "http";

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

  const parsedUrl = new URL(targetUrl);
  const lib = parsedUrl.protocol === "https:" ? https : http;

  const options = {
    hostname: parsedUrl.hostname,
    path: parsedUrl.pathname + parsedUrl.search,
    method: "GET",
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; PodcastLearner/1.0)",
      "Accept": type === "audio"
        ? "audio/mpeg, audio/*, */*"
        : "application/rss+xml, application/xml, text/xml, */*",
    },
  };

  const proxyReq = lib.request(options, (proxyRes) => {
    // Handle redirects
    if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
      const redirectUrl = proxyRes.headers.location;
      const redirectParsed = new URL(redirectUrl, targetUrl);
      const redirectLib = redirectParsed.protocol === "https:" ? https : http;
      const redirectOptions = {
        hostname: redirectParsed.hostname,
        path: redirectParsed.pathname + redirectParsed.search,
        method: "GET",
        headers: options.headers,
      };
      const redirectReq = redirectLib.request(redirectOptions, (redirectRes) => {
        res.setHeader("Content-Type", redirectRes.headers["content-type"] || (type === "audio" ? "audio/mpeg" : "application/xml"));
        res.status(redirectRes.statusCode);
        redirectRes.pipe(res);
      });
      redirectReq.on("error", (e) => res.status(500).json({ error: e.message }));
      redirectReq.end();
      return;
    }

    if (proxyRes.statusCode !== 200) {
      return res.status(proxyRes.statusCode).json({ error: "Upstream " + proxyRes.statusCode });
    }

    res.setHeader("Content-Type", proxyRes.headers["content-type"] || (type === "audio" ? "audio/mpeg" : "application/xml"));
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
