const DEFAULT_TARGET = "https://cinema.lk/";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9,si;q=0.8",
  Referer: DEFAULT_TARGET,
  "Cache-Control": "no-cache"
};

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}

function decodeHtml(str = "") {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)));
}

function stripTags(html = "") {
  return decodeHtml(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).trim();
}

function isCinemaUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (!["http:", "https:"].includes(u.protocol)) return false;
    return u.hostname === "cinema.lk" || u.hostname.endsWith(".cinema.lk");
  } catch (_) {
    return false;
  }
}

function resolveUrl(raw, base) {
  if (!raw || raw.startsWith("data:") || raw.startsWith("javascript:") || raw.startsWith("#")) {
    return null;
  }
  try {
    return new URL(raw.trim(), base).toString();
  } catch (_) {
    return null;
  }
}

function parseTitleAndMeta(rawTitle) {
  const cleaned = rawTitle.replace(/\s+/g, " ").trim();
  const match = cleaned.match(/^(.*?)\s*\.{2,}\s*(\d{1,2}:\d{2}(?::\d{2})?)\s+(\d+)\s*$/);
  if (!match) {
    return { title: cleaned, duration: null, code: null };
  }
  return {
    title: match[1].trim(),
    duration: match[2].trim(),
    code: match[3].trim()
  };
}

function extractCinemaItems(html, baseUrl) {
  const items = [];
  const seen = new Set();
  const anchorRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  let match;
  while ((match = anchorRegex.exec(html)) !== null) {
    const absUrl = resolveUrl(match[1], baseUrl);
    if (!absUrl || !isCinemaUrl(absUrl)) continue;

    const u = new URL(absUrl);
    if (u.pathname === "/" || u.pathname.startsWith("/wp-")) continue;
    if (seen.has(absUrl)) continue;

    const rawText = stripTags(match[2]);
    if (!rawText || rawText.length < 2) continue;

    seen.add(absUrl);
    const meta = parseTitleAndMeta(rawText);
    items.push({
      title: meta.title,
      raw_title: rawText,
      duration: meta.duration,
      code: meta.code,
      url: absUrl
    });
  }

  return items;
}

function extractFullDetails(html, baseUrl) {
  const titleMatch =
    html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) ||
    html.match(/<meta\b[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i) ||
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);

  const descMatch =
    html.match(/<meta\b[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i) ||
    html.match(/<meta\b[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i);

  const posterMatch =
    html.match(/<meta\b[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i) ||
    html.match(/<img\b[^>]*src=["']([^"']+)["'][^>]*>/i);

  const embeds = new Set();
  const streams = new Set();
  const downloads = [];
  const seenDownloadUrls = new Set();

  for (const m of html.matchAll(/<iframe\b[^>]*src=["']([^"']+)["'][^>]*>/gi)) {
    const u = resolveUrl(m[1], baseUrl);
    if (u) embeds.add(u);
  }

  for (const m of html.matchAll(/<(?:video|source)\b[^>]*src=["']([^"']+)["'][^>]*>/gi)) {
    const u = resolveUrl(m[1], baseUrl);
    if (u) streams.add(u);
  }

  for (const m of html.matchAll(/https?:\/\/[^\s"'<>\\)]+\.(?:mp4|m3u8|mpd|webm|mkv)(?:\?[^\s"'<>\\)]*)?/gi)) {
    streams.add(decodeHtml(m[0]));
  }

  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const u = resolveUrl(m[1], baseUrl);
    const label = stripTags(m[2]) || "Link";
    if (!u || seenDownloadUrls.has(u)) continue;

    if (
      /\.(?:mp4|mkv|webm|mp3|zip|rar|7z|srt|vtt)(?:\?|$)/i.test(u) ||
      /download|watch|play|stream|dl|720p|1080p|480p|360p|hd|sd/i.test(label) ||
      /download|watch|stream|gdrive|mega|terabox|mediafire/i.test(u)
    ) {
      seenDownloadUrls.add(u);
      downloads.push({ label, url: u });
    }
  }

  return {
    title: titleMatch ? stripTags(titleMatch[1]) : null,
    description: descMatch ? decodeHtml(descMatch[1]).trim() : null,
    poster: posterMatch ? resolveUrl(posterMatch[1], baseUrl) : null,
    embeds: [...embeds],
    streams: [...streams],
    downloads
  };
}

async function fetchWithTimeout(url, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { headers: HEADERS, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return jsonResponse({}, 200);
    }
    if (request.method !== "GET") {
      return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
    }

    const urlObj = new URL(request.url);
    const path = urlObj.pathname;

    if (path === "/health" || path === "/api/health") {
      return jsonResponse({
        ok: true,
        service: "cinema-lk-worker",
        endpoints: ["/scrape", "/details?url=...", "/search?q=...", "/health"]
      });
    }

    if (path === "/scrape" || path === "/api/scrape") {
      const target = urlObj.searchParams.get("url") || DEFAULT_TARGET;
      if (!isCinemaUrl(target)) {
        return jsonResponse({ ok: false, error: "Only cinema.lk URLs are allowed" }, 400);
      }

      try {
        const res = await fetchWithTimeout(target);
        if (!res.ok) {
          return jsonResponse({ ok: false, error: `Upstream HTTP ${res.status}` }, 502);
        }
        const html = await res.text();
        const pageTitleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        const items = extractCinemaItems(html, target);

        return jsonResponse({
          ok: true,
          source: target,
          page_title: pageTitleMatch ? stripTags(pageTitleMatch[1]) : null,
          total: items.length,
          items
        });
      } catch (err) {
        return jsonResponse({ ok: false, error: err.message || "Scrape failed" }, 500);
      }
    }

    if (path === "/details" || path === "/item" || path === "/api/details" || path === "/api/item") {
      const target = urlObj.searchParams.get("url");
      if (!target || !isCinemaUrl(target)) {
        return jsonResponse({ ok: false, error: "Pass valid ?url=https://cinema.lk/..." }, 400);
      }

      try {
        const res = await fetchWithTimeout(target);
        if (!res.ok) {
          return jsonResponse({ ok: false, error: `Upstream HTTP ${res.status}` }, 502);
        }
        const html = await res.text();
        const details = extractFullDetails(html, target);

        return jsonResponse({
          ok: true,
          url: target,
          ...details
        });
      } catch (err) {
        return jsonResponse({ ok: false, error: err.message || "Details scrape failed" }, 500);
      }
    }

    if (path === "/search" || path === "/api/search") {
      const q = (urlObj.searchParams.get("q") || "").trim().toLowerCase();
      const target = urlObj.searchParams.get("url") || DEFAULT_TARGET;
      if (!q) {
        return jsonResponse({ ok: false, error: "Pass ?q=keyword" }, 400);
      }
      if (!isCinemaUrl(target)) {
        return jsonResponse({ ok: false, error: "Only cinema.lk URLs are allowed" }, 400);
      }

      try {
        const res = await fetchWithTimeout(target);
        if (!res.ok) {
          return jsonResponse({ ok: false, error: `Upstream HTTP ${res.status}` }, 502);
        }
        const html = await res.text();
        const allItems = extractCinemaItems(html, target);
        const matches = allItems.filter(
          (item) =>
            (item.title && item.title.toLowerCase().includes(q)) ||
            (item.raw_title && item.raw_title.toLowerCase().includes(q)) ||
            (item.code && item.code.toLowerCase().includes(q))
        );

        return jsonResponse({
          ok: true,
          query: q,
          source: target,
          total: matches.length,
          items: matches
        });
      } catch (err) {
        return jsonResponse({ ok: false, error: err.message || "Search failed" }, 500);
      }
    }

    return jsonResponse(
      {
        ok: false,
        error: "Not found",
        endpoints: ["/scrape", "/details?url=...", "/search?q=...", "/health"]
      },
      404
    );
  }
};
