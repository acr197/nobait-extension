// NoBait - Background Service Worker
// Fetches article text and calls the AI proxy for summarization

// --- Cross-browser API shim (Chrome uses `chrome`, Firefox exposes `browser`) ---
const api = (typeof browser !== "undefined") ? browser : chrome;

// --- Configuration ---
const PROXY_URL = "https://nobait-proxy.acr197.workers.dev/summarize";
const FETCH_TIMEOUT_MS = 10000;
const AI_TIMEOUT_MS = 15000;
const FEED_TIMEOUT_MS = 6000;
const MAX_CONTENT_LENGTH = 5000;
const MIN_CONTENT_LENGTH = 50;
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// --- Merino endpoint that powers Firefox's own Discovery Stream / Pocket
//     feed. We can't read about:newtab's DOM (Firefox blocks content scripts
//     from privileged pages), so when the sidebar asks us to scrape that
//     page we substitute the same feed Mozilla would have shown there. ---
const MERINO_FEED_URL = "https://merino.services.mozilla.com/api/v1/curated-recommendations";
const FEED_MAX_ITEMS = 12;

// --- Message listener: routes SUMMARIZE and SCRAPE_PAGE requests.
//     Returns a Promise so the same handler works in Chrome (MV3) and Firefox.
//     Both browsers accept a Promise return value as the async response. ---
api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  let responsePromise;
  if (msg.type === "SUMMARIZE") {
    responsePromise = handleSummarize(msg.url, msg.headline).catch(() => ({
      ok: false,
      error: "ai_error",
      message: "An unexpected error occurred.",
    }));
  } else if (msg.type === "SCRAPE_PAGE") {
    responsePromise = handleScrapePage(msg.tabId, msg.url || "").catch(() => ({
      ok: false,
      error: "scrape_failed",
      message: "Could not scan this page.",
      items: [],
    }));
  } else {
    return;
  }

  // Chrome path: call sendResponse and keep the channel open with `return true`.
  // Firefox path: returning the Promise directly is the supported pattern.
  responsePromise.then((res) => {
    try { sendResponse(res); } catch (_) { /* channel may be closed in Firefox */ }
  });
  return responsePromise;
});

// --- handleSummarize: orchestrates fetch -> extract -> AI pipeline ---
async function handleSummarize(url, headline) {
  let articleText;

  // Phase 1: try to fetch the article directly
  try {
    articleText = await fetchArticle(url);
  } catch (_) {
    articleText = null;
  }

  // Phase 2: for Google News redirect URLs, try alternative approaches
  if (!articleText && isGoogleNewsRedirectUrl(url)) {
    // 2a: try to decode the article ID to get the real URL
    const realUrl = decodeGoogleNewsUrl(url);
    if (realUrl) {
      try {
        articleText = await fetchArticle(realUrl);
      } catch (_) { /* fall through */ }
    }

    // 2b: try the RSS variant (server-side redirect)
    if (!articleText) {
      const rssUrl = url.replace(
        /news\.google\.com\/(read|articles)\//,
        "news.google.com/rss/articles/"
      );
      if (rssUrl !== url) {
        try {
          articleText = await fetchArticle(rssUrl);
        } catch (_) { /* fall through */ }
      }
    }
  }

  // Phase 3: send to AI — with article text if available, headline-only otherwise
  try {
    const summary = await callAI(headline, articleText);
    return { ok: true, summary };
  } catch (err) {
    return { ok: false, error: "ai_error", message: err.message || "Summarization failed." };
  }
}

// --- isGoogleNewsRedirectUrl: checks if a URL is a Google News redirect ---
function isGoogleNewsRedirectUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return (host === "news.google.com" || host.endsWith(".news.google.com")) &&
      (u.pathname.startsWith("/read/") || u.pathname.startsWith("/articles/") ||
       u.pathname.startsWith("/rss/articles/"));
  } catch (_) {
    return false;
  }
}

// --- decodeGoogleNewsUrl: tries to extract the real article URL from the
//     base64-encoded article ID in Google News redirect URLs ---
function decodeGoogleNewsUrl(url) {
  try {
    const u = new URL(url);
    // Extract the article ID from paths like /read/CBMi... or /articles/CBMi...
    const match = u.pathname.match(/\/(read|articles)\/(CB[A-Za-z0-9_-]+)/);
    if (!match) return null;

    const articleId = match[2];

    // Base64url → standard base64
    let b64 = articleId.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";

    // Decode to binary string
    const bytes = atob(b64);

    // Scan for "http" in the decoded bytes and extract the URL
    const httpIdx = bytes.indexOf("http");
    if (httpIdx < 0) return null;

    let end = httpIdx;
    while (end < bytes.length) {
      const c = bytes.charCodeAt(end);
      // Stop at control chars or non-ASCII (URL chars are all printable ASCII)
      if (c < 32 || c > 126) break;
      end++;
    }

    const candidate = bytes.substring(httpIdx, end);
    const decoded = new URL(candidate);
    if (decoded.protocol === "http:" || decoded.protocol === "https:") {
      return decoded.href;
    }
  } catch (_) { /* decoding failed */ }
  return null;
}

// --- fetchArticle: downloads the page HTML with a timeout ---
async function fetchArticle(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": BROWSER_UA },
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      throw createError("fetch_failed", "Request timed out. The site took too long to respond.");
    }
    throw createError("fetch_failed", "Could not load the article. Network error.");
  }

  clearTimeout(timer);

  if (response.status === 401 || response.status === 403) {
    throw createError("paywall", "This article is behind a paywall or restricted access.");
  }
  if (response.status === 429) {
    throw createError("blocked", "This site is rate-limiting requests. Try again later.");
  }
  if (!response.ok) {
    throw createError("fetch_failed", `Could not load the article (HTTP ${response.status}).`);
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
    throw createError("fetch_failed", "The link doesn't point to a readable article.");
  }

  let html = await response.text();

  // Handle JS-based redirects (common on news aggregator redirect pages)
  const jsRedirectUrl = extractJsRedirect(html);
  if (jsRedirectUrl) {
    return fetchArticle(jsRedirectUrl);
  }

  const text = extractText(html);

  // If we got very little text and the final URL differs from the request,
  // the page may have been a redirect stub — the extracted text is fine to use
  return text;
}

// --- extractJsRedirect: detects common JS/meta redirect patterns in HTML ---
function extractJsRedirect(html) {
  // Meta refresh: <meta http-equiv="refresh" content="0;url=...">
  const metaMatch = html.match(
    /<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]+content\s*=\s*["']?\d+\s*;\s*url\s*=\s*["']?([^"'\s>]+)/i
  );
  if (metaMatch && metaMatch[1]) {
    try {
      const u = new URL(metaMatch[1]);
      if (u.protocol === "http:" || u.protocol === "https:") return u.href;
    } catch (_) { /* skip */ }
  }

  // window.location / location.href = "..."
  const jsMatch = html.match(
    /(?:window\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/i
  );
  if (jsMatch && jsMatch[1]) {
    try {
      const u = new URL(jsMatch[1]);
      if (u.protocol === "http:" || u.protocol === "https:") return u.href;
    } catch (_) { /* skip */ }
  }

  return null;
}

// --- extractText: strips HTML down to plain text ---
function extractText(html) {
  // Remove non-content blocks
  let text = html.replace(/<script[\s\S]*?<\/script>/gi, " ");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, " ");
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, " ");
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, " ");
  text = text.replace(/<header[\s\S]*?<\/header>/gi, " ");

  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, " ");

  // Decode common HTML entities
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, " ");

  // Collapse whitespace and truncate
  text = text.replace(/\s+/g, " ").trim();
  if (text.length > MAX_CONTENT_LENGTH) {
    text = text.substring(0, MAX_CONTENT_LENGTH) + "...";
  }
  if (text.length < MIN_CONTENT_LENGTH) {
    throw createError("fetch_failed", "Could not extract enough text from the article.");
  }

  return text;
}

// --- callAI: sends the prompt to the Cloudflare Worker proxy ---
async function callAI(headline, content) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  const prompt = buildPrompt(headline, content);

  let response;
  try {
    response = await fetch(PROXY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: prompt }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      throw new Error("AI request timed out.");
    }
    throw new Error("Could not reach the AI service.");
  }

  clearTimeout(timer);

  if (!response.ok) {
    throw new Error(`AI service returned an error (HTTP ${response.status}).`);
  }

  const data = await response.json();
  if (!data.summary) {
    throw new Error("AI returned an empty response.");
  }

  return data.summary;
}

// --- buildPrompt: constructs the full AI prompt from headline + content ---
function buildPrompt(headline, content) {
  if (!content) {
    // Headline-only mode: AI answers from its own knowledge
    return `You are NoBait, an AI that cuts through clickbait. The full article could not be loaded, but based on the headline below and your knowledge, provide the ACTUAL answer or key information the headline is teasing.

Rules:
- Give the direct answer in 1-3 sentences max
- No fluff, no filler, no rewording the headline
- If the headline asks a question, answer it directly
- If it's a listicle tease, give the key item(s)
- If it's rage/shock bait, state what actually happened plainly
- If you genuinely don't know the answer, say so briefly

Headline: "${headline}"

Direct answer:`;
  }

  return `You are NoBait, an AI that cuts through clickbait. Given a headline and the article content, provide the ACTUAL answer or key information the headline is teasing.

Rules:
- Give the direct answer in 1-3 sentences max
- No fluff, no filler, no rewording the headline
- If the headline asks a question, answer it directly
- If it's a listicle tease, give the key item(s)
- If it's rage/shock bait, state what actually happened plainly
- If the article doesn't actually answer its own headline, say so

Headline: "${headline}"

Article content:
${content}

Direct answer:`;
}

// --- createError: builds an Error with an errorType property ---
function createError(errorType, message) {
  const err = new Error(message);
  err.errorType = errorType;
  return err;
}

// =========================================================================
// SCRAPE PAGE (sidebar fallback for when long-click doesn't work)
// =========================================================================

// --- handleScrapePage: returns a list of news links the sidebar can summarize.
//     For about:newtab/about:home (which extensions can't inject into) we fetch
//     Mozilla's Merino curated-recommendations feed -- the same data Firefox
//     itself shows on the new tab page. For every other URL we ask the content
//     script in that tab to extract anchors via EXTRACT_LINKS. ---
async function handleScrapePage(tabId, url) {
  const lowered = (url || "").toLowerCase();

  // about:newtab / about:home: content scripts are blocked, use Merino feed
  if (lowered.startsWith("about:newtab") || lowered.startsWith("about:home")) {
    try {
      const items = await fetchMerinoFeed();
      if (!items.length) {
        return {
          ok: false,
          error: "newtab_unavailable",
          message: "Could not load Firefox's recommended stories.",
          items: [],
        };
      }
      return { ok: true, items };
    } catch (_) {
      return {
        ok: false,
        error: "newtab_unavailable",
        message: "Could not reach Firefox's story feed.",
        items: [],
      };
    }
  }

  // Other privileged about: / chrome: pages we can't scrape at all
  if (lowered.startsWith("about:") || lowered.startsWith("chrome:") ||
      lowered.startsWith("moz-extension:") || lowered.startsWith("chrome-extension:")) {
    return {
      ok: false,
      error: "restricted_page",
      message: "This browser page is restricted. Try it on a regular website.",
      items: [],
    };
  }

  // Regular page: ask the content script to walk the DOM
  if (typeof tabId !== "number") {
    return {
      ok: false,
      error: "no_tab",
      message: "Could not identify the active tab.",
      items: [],
    };
  }

  let response;
  try {
    response = await Promise.resolve(api.tabs.sendMessage(tabId, { type: "EXTRACT_LINKS" }));
  } catch (_) {
    return {
      ok: false,
      error: "no_content_script",
      message: "Could not connect to this page. Reload it and try again.",
      items: [],
    };
  }

  if (!response || !Array.isArray(response.items) || response.items.length === 0) {
    return {
      ok: false,
      error: "no_links",
      message: "No news article links found on this page.",
      items: [],
    };
  }

  return { ok: true, items: response.items };
}

// --- fetchMerinoFeed: pulls Firefox's curated stories. The Merino service
//     accepts POST with locale/region/count and returns a JSON envelope whose
//     shape has changed across versions, so normalizeFeedItems is defensive
//     about where the array of items lives. ---
async function fetchMerinoFeed() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(MERINO_FEED_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locale: "en-US", region: "US", count: FEED_MAX_ITEMS }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    return [];
  }

  clearTimeout(timer);
  if (!response.ok) return [];

  let data;
  try {
    data = await response.json();
  } catch (_) {
    return [];
  }

  return normalizeFeedItems(data);
}

// --- normalizeFeedItems: walks the Merino response in priority order and
//     converts each entry into the { url, title, source } shape the sidebar
//     expects. Mozilla has shipped at least three different envelope shapes
//     for this endpoint (top-level `data`, `recommendations`, and per-feed
//     buckets), so we check all of them and stop at the first non-empty list. ---
function normalizeFeedItems(data) {
  if (!data || typeof data !== "object") return [];

  const buckets = [];
  if (Array.isArray(data.data)) buckets.push(data.data);
  if (Array.isArray(data.recommendations)) buckets.push(data.recommendations);
  if (data.feeds && typeof data.feeds === "object") {
    for (const key of Object.keys(data.feeds)) {
      const feed = data.feeds[key];
      if (feed && Array.isArray(feed.recommendations)) buckets.push(feed.recommendations);
      if (Array.isArray(feed)) buckets.push(feed);
    }
  }

  const out = [];
  const seen = new Set();
  for (const list of buckets) {
    for (const entry of list) {
      if (out.length >= FEED_MAX_ITEMS) break;
      if (!entry || typeof entry !== "object") continue;

      const url = pickString(entry, ["url", "link", "permalink"]);
      const title = pickString(entry, ["title", "headline", "name"]);
      if (!url || !title) continue;
      if (seen.has(url)) continue;

      // Validate it's an http(s) URL
      let parsed;
      try {
        parsed = new URL(url);
      } catch (_) { continue; }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;

      const source =
        pickString(entry, ["publisher", "domain", "source"]) ||
        parsed.hostname.replace(/^www\./, "");

      seen.add(url);
      out.push({ url, title, source });
    }
    if (out.length >= FEED_MAX_ITEMS) break;
  }

  return out;
}

// --- pickString: returns the first non-empty string value found at any of
//     the candidate keys on the given object. Used to defensively extract
//     fields from Merino entries whose schema varies. ---
function pickString(obj, keys) {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}
