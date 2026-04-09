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
const MIN_CONTENT_LENGTH = 200;
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

// --- captureFetchError: normalizes a fetchArticle error into { type, message }.
//     The message is user-facing and gets fed directly into the AI prompt, so
//     it should read as a plain sentence the user can understand. ---
function captureFetchError(err) {
  const type = (err && err.errorType) || "fetch_failed";
  let message = (err && err.message) || "Could not load the article.";
  // Normalize trailing period for consistent formatting inside the prompt.
  if (!/[.!?]$/.test(message)) message += ".";
  return { type, message };
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

// --- Googlebot UA: many sites (esp. paywalled / SPA) serve clean static HTML
//     to search engines but gate real browsers. A retry with Googlebot UA
//     rescues a lot of articles that otherwise come back as thin shells. ---
const GOOGLEBOT_UA =
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

// --- fetchArticle: downloads the page HTML with a timeout. If the first
//     attempt returns a thin/anti-bot/paywall page, retry once as Googlebot. ---
async function fetchArticle(url, opts) {
  opts = opts || {};
  const depth = opts.depth || 0;
  if (depth > 4) {
    throw createError("fetch_failed", "Too many redirects while loading the article.");
  }

  let result;
  try {
    result = await fetchRaw(url, BROWSER_UA);
  } catch (err) {
    // If the browser UA was blocked, try Googlebot as a last resort
    if (!opts.noRetry && (err.errorType === "paywall" || err.errorType === "blocked")) {
      try {
        result = await fetchRaw(url, GOOGLEBOT_UA);
      } catch (_) {
        throw err; // surface the original, more accurate reason
      }
    } else {
      throw err;
    }
  }

  let html = result.html;

  // Handle JS-based redirects (common on news aggregator redirect pages)
  const jsRedirectUrl = extractJsRedirect(html, url);
  if (jsRedirectUrl && jsRedirectUrl !== url) {
    return fetchArticle(jsRedirectUrl, { depth: depth + 1 });
  }

  // Detect anti-bot interstitials (Cloudflare challenge, "Please enable JS",
  // Akamai Bot Manager, etc.) and convert them into a clean "blocked" error.
  if (looksLikeAntiBot(html)) {
    if (!opts.noRetry) {
      // One retry as Googlebot — anti-bot pages often whitelist search crawlers.
      try {
        const retry = await fetchRaw(url, GOOGLEBOT_UA);
        if (!looksLikeAntiBot(retry.html)) {
          html = retry.html;
        } else {
          throw createError("blocked", "Blocked by the site's bot protection.");
        }
      } catch (err) {
        if (err.errorType) throw err;
        throw createError("blocked", "Blocked by the site's bot protection.");
      }
    } else {
      throw createError("blocked", "Blocked by the site's bot protection.");
    }
  }

  // Detect paywall interstitials by content heuristics.
  if (looksLikePaywall(html)) {
    throw createError("paywall", "Behind a paywall.");
  }

  let text;
  try {
    text = extractText(html);
  } catch (err) {
    // If extraction failed because the page was too thin, try Googlebot once.
    if (!opts.noRetry && err.errorType === "fetch_failed") {
      try {
        const retry = await fetchRaw(url, GOOGLEBOT_UA);
        const retryRedirect = extractJsRedirect(retry.html, url);
        if (retryRedirect && retryRedirect !== url) {
          return fetchArticle(retryRedirect, { depth: depth + 1 });
        }
        text = extractText(retry.html);
      } catch (_) {
        throw err;
      }
    } else {
      throw err;
    }
  }

  return text;
}

// --- fetchRaw: single HTTP fetch with a specific UA. Returns { html }. ---
async function fetchRaw(url, ua) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": ua,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      throw createError("fetch_failed", "Site took too long to respond.");
    }
    throw createError("fetch_failed", "Network error loading the article.");
  }

  clearTimeout(timer);

  if (response.status === 401 || response.status === 403) {
    throw createError("paywall", "Blocked by the site (HTTP " + response.status + "). Likely paywall or access restriction.");
  }
  if (response.status === 429) {
    throw createError("blocked", "Rate-limited by the site (HTTP 429).");
  }
  if (response.status === 451) {
    throw createError("blocked", "Blocked for legal reasons (HTTP 451).");
  }
  if (!response.ok) {
    throw createError("fetch_failed", "Site returned HTTP " + response.status + ".");
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html") && !contentType.includes("text/plain") && !contentType.includes("xml")) {
    throw createError("fetch_failed", "Link doesn't point to a readable article (" + (contentType || "unknown type") + ").");
  }

  const html = await response.text();
  return { html, finalUrl: response.url || url };
}

// --- looksLikeAntiBot: heuristic for Cloudflare / Akamai / "enable JS" walls ---
function looksLikeAntiBot(html) {
  if (!html) return false;
  const head = html.substring(0, 4000).toLowerCase();
  // Cloudflare challenge pages
  if (head.includes("just a moment") && head.includes("cloudflare")) return true;
  if (head.includes("checking your browser") && head.includes("cloudflare")) return true;
  if (head.includes("cf-browser-verification")) return true;
  if (head.includes("cf_chl_opt")) return true;
  // Akamai / PerimeterX / DataDome
  if (head.includes("access denied") && head.includes("reference #")) return true;
  if (head.includes("px-captcha")) return true;
  if (head.includes("datadome")) return true;
  // Generic "please enable JavaScript" walls on otherwise empty bodies
  if (html.length < 2500 && /enable javascript|requires javascript/i.test(head)) return true;
  return false;
}

// --- looksLikePaywall: heuristic for paywall interstitials ---
function looksLikePaywall(html) {
  if (!html) return false;
  const lower = html.toLowerCase();
  // Common NYT/WSJ/FT/Bloomberg paywall markers
  if (lower.includes("subscribe to continue") && lower.length < 8000) return true;
  if (lower.includes("to continue reading") && lower.includes("subscribe")) {
    // Only flag if the body is short — long articles may mention "subscribe" in footers
    if (lower.length < 6000) return true;
  }
  return false;
}

// --- extractJsRedirect: detects common JS/meta redirect patterns in HTML ---
function extractJsRedirect(html, baseUrl) {
  const tryParse = (candidate) => {
    if (!candidate) return null;
    try {
      const u = new URL(candidate, baseUrl || undefined);
      if (u.protocol === "http:" || u.protocol === "https:") return u.href;
    } catch (_) { /* skip */ }
    return null;
  };

  // Meta refresh: <meta http-equiv="refresh" content="0;url=...">
  const metaMatch = html.match(
    /<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]+content\s*=\s*["']?\d+\s*;\s*url\s*=\s*["']?([^"'\s>]+)/i
  );
  const metaUrl = tryParse(metaMatch && metaMatch[1]);
  if (metaUrl) return metaUrl;

  // Canonical link — Google News redirect stubs often include one pointing at
  // the real publisher URL.
  const canonicalMatch = html.match(
    /<link[^>]+rel\s*=\s*["']?canonical["']?[^>]+href\s*=\s*["']([^"']+)["']/i
  );
  const canonicalUrl = tryParse(canonicalMatch && canonicalMatch[1]);
  if (canonicalUrl && /news\.google\.com/.test(baseUrl || "") && !/news\.google\.com/.test(canonicalUrl)) {
    return canonicalUrl;
  }

  // Broad set of JS location-assignment patterns:
  //   window.location = "..."
  //   window.location.href = "..."
  //   window.location.replace("...")
  //   window.location.assign("...")
  //   document.location = "..."
  //   top.location = "..."
  //   self.location = "..."
  const patterns = [
    /(?:window|document|top|self|parent)?\.?location(?:\.href)?\s*=\s*["']([^"']+)["']/i,
    /(?:window|document|top|self|parent)?\.?location\.(?:replace|assign)\s*\(\s*["']([^"']+)["']\s*\)/i,
    /window\.top\.location(?:\.href)?\s*=\s*["']([^"']+)["']/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    const u = tryParse(m && m[1]);
    if (u) return u;
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
  // The whole point of NoBait is that the user does NOT have to go read the
  // article themselves. Anything that redirects them back to the source,
  // tells them to research, or hedges with "I don't have access" is a
  // failure of the product. Both prompts share this forbidden-phrase list.
  const FORBIDDEN = `ABSOLUTELY FORBIDDEN — never output ANY of these phrases or anything like them:
- "do your own research" / "for more information" / "for the latest updates"
- "open the article" / "open original" / "read the full article" / "click the link"
- "check local news" / "check official sources" / "refer to" / "visit the website"
- "I recommend" / "I suggest" / "consider checking" / "you may want to"
- "I don't have access" / "I cannot access" / "I'm unable to" / "I don't know the content"
- "try again later" / "contact the site" / "the article is behind"
The user came here so they would NOT have to do any of that. You are their last stop. Deliver the answer or the honest verdict — never bounce them back.`;

  if (!content) {
    const reason = fetchError && fetchError.message
      ? fetchError.message
      : "The article text could not be loaded.";

    // Headline-only mode: the model has no article text to work with.
    // Structure: one short "why it's missing" sentence, then the best
    // substantive answer we can give from general knowledge.
    return `You are NoBait, an AI that cuts through clickbait. The article text could not be fetched. Reason: ${reason}

${FORBIDDEN}

RESPONSE FORMAT (exactly this shape, 2-3 sentences total):
1. ONE short sentence stating the specific reason the text couldn't be loaded, in plain English. Examples: "Blocked by the site's bot protection." / "Behind a paywall." / "Site timed out." / "Blocked by robots.txt." Use the reason above verbatim if you don't know better.
2. THEN 1-2 sentences answering the headline with concrete specifics from your general knowledge — exact dates, exact prices, exact numbers, names, outcomes. If the headline is a question, answer it. If it teases a fact, state the fact.
3. If you genuinely don't know any specifics and the topic is too fresh for your training data, say so in one honest sentence ("This is more recent than my training data, so I can't confirm specifics.") — but still give whatever useful context you DO have. Do NOT send the user elsewhere.

CLICKBAIT VERDICT: If the headline is pure bait that promises an answer it won't keep (e.g. "You won't believe…", "This one trick…", "Doctors hate…"), respond with EXACTLY one line:
CLICKBAIT: <one short snarky sentence calling out the bait>

Headline: "${headline}"

Response:`;
  }

  return `You are NoBait, an AI that cuts through clickbait. You've been given the article's text. Tell the reader the SPECIFIC, concrete information the headline was teasing.

${FORBIDDEN}

HARD RULES:
1. Max 2-3 sentences, tight and factual. No filler, no "this article discusses…", no "according to the article".
2. NEVER just rephrase the headline. If the headline says "Samsung sets release for April", your answer MUST name the specific date from the article — or explicitly say only the month is confirmed and no day was given.
3. ALWAYS hunt for and surface concrete specifics: exact dates, exact prices, exact percentages, exact numbers, names, quantities, outcomes. That is the entire point of this product.
4. If the headline asks a question, answer the question directly with facts from the article.
5. If the article's specifics contradict the headline, say so.
6. If the article partially answers the headline (e.g. month but not day, or "later this year" with no date), state what IS confirmed AND what is still unknown in one sentence — but do NOT tell the user to go look it up.
7. CLICKBAIT DETECTION — if the article genuinely provides no new specifics beyond restating the headline, respond with EXACTLY one line:
   CLICKBAIT: <one short snarky sentence calling out the article>
   Use this ONLY when the article truly adds nothing. If there's ANY additional specific fact, share the fact instead.

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
