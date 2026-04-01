export default async function handler(req, res) {
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

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 50000);

    const response = await fetch(targetUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": type === "audio"
          ? "audio/mpeg, audio/*, */*"
          : "application/rss+xml, application/xml, text/xml, */*",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return res.status(response.status).json({
        error: "Upstream " + response.status + ": " + response.statusText,
      });
    }

    const contentType = response.headers.get("content-type") || "";

    if (type === "audio") {
      res.setHeader("Content-Type", contentType || "audio/mpeg");
      const contentLength = response.headers.get("content-length");
      if (contentLength) res.setHeader("Content-Length", contentLength);
      const buffer = await response.arrayBuffer();
      return res.send(Buffer.from(buffer));
    } else {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      const text = await response.text();
      return res.send(text);
    }
  } catch (err) {
    return res.status(500).json({
      error: err.message,
      name: err.name,
      target: targetUrl,
    });
  }
}
