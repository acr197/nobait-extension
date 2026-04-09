// NoBait - Background Service Worker
// Fetches article text and calls the AI proxy for summarization

// --- Cross-browser API shim (Chrome uses `chrome`, Firefox exposes `browser`) ---
const api = (typeof browser !== "undefined") ? browser : chrome;

// --- Firefox: clicking the action icon opens the sidebar instead of the
//     trigger-settings popup. The sidebar provides a fallback reader for pages
//     where long-click / shift-click can't be used (Firefox home, sites that
//     eat pointer events, etc.). Chrome has no sidebarAction API, so it keeps
//     the manifest popup as-is. ---
if (typeof browser !== "undefined" && browser.sidebarAction && browser.action) {
  // Clearing the popup makes action.onClicked fire when the icon is clicked
  Promise.resolve(browser.action.setPopup({ popup: "" })).catch(() => {});
  browser.action.onClicked.addListener(() => {
    Promise.resolve(browser.sidebarAction.toggle()).catch(() => {});
  });
}

// --- Configuration ---
const PROXY_URL = "https://nobait-proxy.acr197.workers.dev/summarize";
const FETCH_TIMEOUT_MS = 10000;
const AI_TIMEOUT_MS = 15000;
const MAX_CONTENT_LENGTH = 5000;
const MIN_CONTENT_LENGTH = 50;
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// --- Message listener: routes SUMMARIZE + FETCH_TRENDING_NEWS requests.
//     Returns a Promise so the same handler works in Chrome (MV3) and Firefox.
//     Both browsers accept a Promise return value as the async response. ---
api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === "SUMMARIZE") {
    const responsePromise = handleSummarize(msg.url, msg.headline).catch(() => ({
      ok: false,
      error: "ai_error",
      message: "An unexpected error occurred.",
    }));
    responsePromise.then((res) => {
      try { sendResponse(res); } catch (_) { /* channel may be closed in Firefox */ }
    });
    return responsePromise;
  }

  if (msg.type === "FETCH_TRENDING_NEWS") {
    const responsePromise = handleFetchTrendingNews().catch((err) => ({
      ok: false,
      error: "fetch_failed",
      message: (err && err.message) || "Could not load trending news.",
    }));
    responsePromise.then((res) => {
      try { sendResponse(res); } catch (_) { /* channel may be closed in Firefox */ }
    });
    return responsePromise;
  }
});

// --- handleSummarize: orchestrates fetch -> extract -> AI pipeline ---
async function handleSummarize(url, headline) {
  let articleText = null;
  let fetchError = null;

  // Phase 1: try to fetch the article directly
  try {
    articleText = await fetchArticle(url);
  } catch (err) {
    fetchError = captureFetchError(err);
  }

  // Phase 2: for Google News redirect URLs, try alternative approaches
  if (!articleText && isGoogleNewsRedirectUrl(url)) {
    // 2a: try to decode the article ID to get the real URL
    const realUrl = decodeGoogleNewsUrl(url);
    if (realUrl) {
      try {
        articleText = await fetchArticle(realUrl);
        fetchError = null;
      } catch (err) {
        fetchError = captureFetchError(err);
      }
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
          fetchError = null;
        } catch (err) {
          fetchError = captureFetchError(err);
        }
      }
    }
  }

  // Hard failures: surface them to the user directly rather than hallucinating
  // a summary. Soft failures (generic network / parse issues) still fall
  // through to headline-only mode so the user sees something useful.
  if (!articleText && fetchError && (fetchError.type === "paywall" || fetchError.type === "blocked")) {
    return { ok: false, error: fetchError.type, message: fetchError.message };
  }

  // Phase 3: send to AI — with article text if available, headline-only otherwise.
  // Pass fetchError along so the prompt can explain *why* content is missing.
  try {
    const summary = await callAI(headline, articleText, fetchError);
    return { ok: true, summary };
  } catch (err) {
    return { ok: false, error: "ai_error", message: err.message || "Summarization failed." };
  }
}

// --- captureFetchError: normalizes a fetchArticle error into { type, message } ---
function captureFetchError(err) {
  return {
    type: (err && err.errorType) || "fetch_failed",
    message: (err && err.message) || "Could not load the article.",
  };
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
async function callAI(headline, content, fetchError) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  const prompt = buildPrompt(headline, content, fetchError);

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

// --- buildPrompt: constructs the full AI prompt from headline + content.
//     fetchError (optional) is passed when we couldn't load article text so
//     the model can explain *why* it's working from the headline alone. ---
function buildPrompt(headline, content, fetchError) {
  if (!content) {
    const reason = fetchError && fetchError.message
      ? fetchError.message
      : "The article text could not be loaded.";

    // Headline-only mode: the model has no article text to work with.
    return `You are NoBait, an AI that cuts through clickbait headlines. The article text could NOT be loaded (reason: ${reason}). Work from the headline and your general knowledge.

RULES:
- Answer in 1-3 sentences, direct and specific.
- Include concrete facts when you can: names, numbers, dates, outcomes.
- DO NOT write "I don't have access", "I cannot access", or "I don't know the content" — the user already knows the fetch failed; that phrasing is unhelpful.
- If the headline asks a question you can answer from general knowledge, answer it plainly.
- If the topic is time-sensitive and you genuinely lack specifics, say exactly: "Couldn't load the article text. Try 'Open original' for the full story." and then add one sentence of useful context from what you do know.
- If the headline is obviously pure clickbait that promises an answer it cannot keep (e.g. "You won't believe…"), respond with EXACTLY one line starting with \`CLICKBAIT:\` followed by a short snarky sentence calling out the bait.

Headline: "${headline}"

Response:`;
  }

  return `You are NoBait, an AI that cuts through clickbait. You've been given the article's text. Tell the reader the SPECIFIC, concrete information that the headline was teasing.

HARD RULES:
1. Max 2-3 sentences, tight and factual. No filler, no "this article discusses…".
2. NEVER just rephrase the headline. If the headline says "Samsung sets release for April", your answer MUST name the specific date — or explicitly say only the month is confirmed and no day was given.
3. ALWAYS prefer specifics: numbers, prices, percentages, dates, names, quantities, outcomes.
4. If the headline asks a question, answer the question directly using facts from the article.
5. If the article names specifics that contradict the headline, say so.
6. If the article partially answers the headline (e.g. month but not day), state what IS confirmed AND what is still unknown in one sentence.
7. CLICKBAIT DETECTION — if the article genuinely provides no new specifics beyond restating the headline (the classic "the article answers its own question with the same words" pattern), respond with EXACTLY one line in this format:
   CLICKBAIT: <one short, snarky sentence calling out the article>
   Use this ONLY when the article truly adds nothing. If there's ANY additional specific fact, do not use the clickbait format — share that fact instead.

Headline: "${headline}"

Article content:
${content}

Response:`;
}

// --- createError: builds an Error with an errorType property ---
function createError(errorType, message) {
  const err = new Error(message);
  err.errorType = errorType;
  return err;
}

// =========================================================================
// TRENDING NEWS FALLBACK
// =========================================================================
//
// When the sidebar is opened on a privileged page (about:home, about:newtab,
// about:blank, etc.), there's no content script to scan for headlines. To
// keep the sidebar useful we fetch Google News' public top-stories RSS feed
// and return structured article entries for the sidebar to render. The
// sidebar shows its inline summary modal for these entries because the
// source page isn't scriptable.

const TRENDING_RSS_URL = "https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en";
const TRENDING_MAX = 60;

async function handleFetchTrendingNews() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(TRENDING_RSS_URL, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": BROWSER_UA,
        "Accept": "application/rss+xml, application/xml, text/xml, */*",
      },
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error("Could not load trending news.");
  }
  clearTimeout(timer);

  if (!response.ok) {
    throw new Error("Trending news unavailable (HTTP " + response.status + ").");
  }

  const xml = await response.text();
  const links = parseGoogleNewsRss(xml);
  return { ok: true, links };
}

// --- parseGoogleNewsRss: extracts items from the Google News RSS feed into
//     { url, headline, source } objects. Uses regex rather than DOMParser
//     because DOMParser is not available in Chrome MV3 service workers. ---
function parseGoogleNewsRss(xml) {
  const out = [];
  const itemRegex = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRegex.exec(xml)) !== null && out.length < TRENDING_MAX) {
    const item = m[1];
    const title = extractRssTag(item, "title");
    const link = extractRssTag(item, "link");
    const source = extractRssTag(item, "source");
    if (!title || !link) continue;

    // Google News appends " - SourceName" to titles; strip it so the
    // sidebar headline is clean.
    let headline = decodeRssEntities(title).trim();
    const dashIdx = headline.lastIndexOf(" - ");
    if (dashIdx > 10 && dashIdx >= headline.length - 60) {
      headline = headline.substring(0, dashIdx).trim();
    }
    if (headline.length < 10) continue;

    const url = decodeRssEntities(link).trim();
    let sourceName = source ? decodeRssEntities(source).trim() : "";
    if (!sourceName) sourceName = "news.google.com";

    out.push({ url, headline, source: sourceName });
  }
  return out;
}

// --- extractRssTag: pulls the inner text of <tag>…</tag>, tolerating
//     attributes on the opening tag and optional CDATA wrappers. ---
function extractRssTag(xml, tag) {
  const re = new RegExp(
    "<" + tag + "\\b[^>]*>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*<\\/" + tag + "\\s*>",
    "i"
  );
  const m = xml.match(re);
  return m ? m[1] : null;
}

function decodeRssEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ");
}
