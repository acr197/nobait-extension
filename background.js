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
const FETCH_TIMEOUT_MS = 12000;
const AI_TIMEOUT_MS = 20000;
const MAX_CONTENT_LENGTH = 6000;
const MIN_CONTENT_LENGTH = 140;
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// --- Message listener: routes SUMMARIZE requests from the content script
//     and the sidebar. Returns a Promise so the same handler works in Chrome
//     (MV3) and Firefox. ---
api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === "SUMMARIZE") {
    const mode = msg.mode === "detailed" ? "detailed" : "short";
    const responsePromise = handleSummarize(msg.url, msg.headline, mode).catch(() => ({
      ok: false,
      error: "ai_error",
      message: "An unexpected error occurred.",
    }));
    responsePromise.then((res) => {
      try { sendResponse(res); } catch (_) { /* channel may be closed in Firefox */ }
    });
    return responsePromise;
  }
});

// --- handleSummarize: orchestrates fetch -> extract -> AI pipeline.
//     Always returns ok:true as long as the AI responds, even when the
//     article text couldn't be fetched. In that case contentStatus reports
//     "blocked" / "paywall" / "fetch_failed" and contentStatusMessage is the
//     single-line user-facing reason. The UI uses that to show
//     "<reason>" + "Its attempt at a summary: …". ---
async function handleSummarize(url, headline, mode) {
  let articleText = null;
  let fetchError = null;

  // Google News URLs: the /articles/ and /read/ pages are JS-redirect stubs
  // that rarely yield useful HTML on direct fetch. The /rss/articles/ variant
  // returns a server-side 302 straight to the publisher, which fetch() follows
  // automatically. So for Google News we try the RSS form first.
  const googleNewsRss = buildGoogleNewsRssUrl(url);

  if (googleNewsRss) {
    try {
      articleText = await fetchArticle(googleNewsRss);
    } catch (err) {
      fetchError = captureFetchError(err);
    }

    if (!articleText) {
      const realUrl = decodeGoogleNewsUrl(url);
      if (realUrl) {
        try {
          articleText = await fetchArticle(realUrl);
          fetchError = null;
        } catch (err) {
          fetchError = captureFetchError(err);
        }
      }
    }
  }

  // Standard path: fetch the requested URL directly.
  if (!articleText) {
    try {
      articleText = await fetchArticle(url);
      fetchError = null;
    } catch (err) {
      if (!fetchError) fetchError = captureFetchError(err);
    }
  }

  // Phase 3: send to AI — with article text if available, headline-only otherwise.
  // Pass fetchError along so the prompt knows *why* content is missing.
  const contentStatus = articleText ? "ok" : (fetchError && fetchError.type) || "fetch_failed";
  const contentStatusMessage = articleText
    ? null
    : (fetchError && fetchError.message) || "Could not load the article.";

  try {
    const summary = await callAI(headline, articleText, fetchError, mode);
    return {
      ok: true,
      summary,
      contentStatus,
      contentStatusMessage,
    };
  } catch (err) {
    return { ok: false, error: "ai_error", message: err.message || "Summarization failed." };
  }
}

// --- buildGoogleNewsRssUrl: converts a news.google.com article/read URL to
//     its /rss/articles/ equivalent (which 302s to the publisher). Returns
//     null if the URL isn't a Google News redirect stub. ---
function buildGoogleNewsRssUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host !== "news.google.com" && !host.endsWith(".news.google.com")) return null;
    if (u.pathname.startsWith("/rss/articles/")) return u.href;
    if (u.pathname.startsWith("/read/") || u.pathname.startsWith("/articles/")) {
      return u.href.replace(
        /news\.google\.com\/(read|articles)\//,
        "news.google.com/rss/articles/"
      );
    }
    return null;
  } catch (_) {
    return null;
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

// --- fetchArticle: downloads the page HTML with a timeout, follows any
//     meta-refresh / canonical / JS redirect stubs, and retries with a
//     Googlebot UA when the site blocks real browsers. Returns the extracted
//     plain text of the final article. ---
async function fetchArticle(url, opts) {
  opts = opts || {};
  const depth = opts.depth || 0;
  if (depth > 5) {
    throw createError("fetch_failed", "Too many redirects while loading the article.");
  }

  // Fetch with the browser UA first, then fall back to Googlebot on block.
  let result;
  try {
    result = await fetchRaw(url, BROWSER_UA);
  } catch (err) {
    if (err.errorType === "paywall" || err.errorType === "blocked") {
      try {
        result = await fetchRaw(url, GOOGLEBOT_UA);
      } catch (_) {
        throw err; // surface the more specific original reason
      }
    } else {
      throw err;
    }
  }

  let html = result.html;
  // `finalUrl` is where fetch() actually landed after any HTTP 3xx redirects.
  // We carry it forward so further JS/meta redirects resolve against the real
  // page and not the pre-redirect Google News stub.
  let baseUrl = result.finalUrl || url;

  // If the HTML is a JS/meta/canonical redirect stub, hop to the real URL.
  const jsRedirectUrl = extractJsRedirect(html, baseUrl);
  if (jsRedirectUrl && jsRedirectUrl !== baseUrl) {
    return fetchArticle(jsRedirectUrl, { depth: depth + 1 });
  }

  // Anti-bot interstitial? Retry once as Googlebot before giving up.
  if (looksLikeAntiBot(html)) {
    try {
      const retry = await fetchRaw(url, GOOGLEBOT_UA);
      if (looksLikeAntiBot(retry.html)) {
        throw createError("blocked", "Blocked by the site's bot protection.");
      }
      html = retry.html;
      baseUrl = retry.finalUrl || baseUrl;
      const retryRedirect = extractJsRedirect(html, baseUrl);
      if (retryRedirect && retryRedirect !== baseUrl) {
        return fetchArticle(retryRedirect, { depth: depth + 1 });
      }
    } catch (err) {
      if (err.errorType) throw err;
      throw createError("blocked", "Blocked by the site's bot protection.");
    }
  }

  // Paywall interstitial.
  if (looksLikePaywall(html)) {
    throw createError("paywall", "Behind a paywall.");
  }

  // Extract readable text. On thin pages, retry once as Googlebot — many SSR
  // sites ship a richer static HTML to search crawlers than to browsers.
  try {
    return extractText(html);
  } catch (err) {
    if (err.errorType !== "fetch_failed") throw err;
    try {
      const retry = await fetchRaw(url, GOOGLEBOT_UA);
      const retryRedirect = extractJsRedirect(retry.html, retry.finalUrl || baseUrl);
      if (retryRedirect && retryRedirect !== (retry.finalUrl || baseUrl)) {
        return fetchArticle(retryRedirect, { depth: depth + 1 });
      }
      return extractText(retry.html);
    } catch (_) {
      throw err;
    }
  }
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

// --- extractText: pulls readable article text out of raw HTML.
//     Strategy:
//       1. Strip obvious non-content blocks (script, style, nav, aside, etc).
//       2. Try to isolate a main content container (<article>, <main>).
//       3. Prefer <p> paragraphs from that container.
//       4. If that's too thin, fall back to stripped full-body text.
//       5. Last resort: use the page's meta description / og:description. ---
function extractText(html) {
  if (!html) throw createError("fetch_failed", "No HTML to extract.");

  // Strip non-content blocks.
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<template[\s\S]*?<\/template>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, " ")
    .replace(/<header\b[\s\S]*?<\/header>/gi, " ")
    .replace(/<aside\b[\s\S]*?<\/aside>/gi, " ")
    .replace(/<form\b[\s\S]*?<\/form>/gi, " ")
    .replace(/<figure\b[\s\S]*?<\/figure>/gi, " ")
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, " ");

  // Try to pull out the main content container first.
  const container = extractMainContainer(cleaned) || cleaned;

  // Prefer the concatenated text of all substantial <p> blocks.
  let text = extractParagraphs(container);

  // If paragraphs were thin, fall back to stripping tags from the container.
  if (!text || text.length < MIN_CONTENT_LENGTH) {
    text = stripTags(container);
  }

  text = decodeEntities(text).replace(/\s+/g, " ").trim();

  // Last-resort: meta description from the original raw HTML.
  if (text.length < MIN_CONTENT_LENGTH) {
    const metaDesc = extractMetaDescription(html);
    if (metaDesc && metaDesc.length >= 80) {
      text = metaDesc;
    }
  }

  if (text.length > MAX_CONTENT_LENGTH) {
    text = text.substring(0, MAX_CONTENT_LENGTH) + "...";
  }
  if (text.length < MIN_CONTENT_LENGTH) {
    throw createError("fetch_failed", "Could not extract enough text from the article.");
  }
  return text;
}

// --- extractMainContainer: returns the inner HTML of the most likely main
//     content element (<article>, <main>) — whichever has the most content. ---
function extractMainContainer(html) {
  let best = null;
  const articleRe = /<article\b[\s\S]*?<\/article>/gi;
  let m;
  while ((m = articleRe.exec(html)) !== null) {
    if (!best || m[0].length > best.length) best = m[0];
  }
  const mainMatch = html.match(/<main\b[\s\S]*?<\/main>/i);
  if (mainMatch && (!best || mainMatch[0].length > best.length)) {
    best = mainMatch[0];
  }
  return best && best.length > 400 ? best : null;
}

// --- extractParagraphs: concatenates the inner text of all non-trivial
//     <p> tags in the given HTML chunk. ---
function extractParagraphs(html) {
  const out = [];
  const re = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const inner = stripTags(m[1]);
    if (inner && inner.length >= 40) out.push(inner);
  }
  return out.join(" ");
}

// --- stripTags: removes every remaining HTML tag and collapses whitespace. ---
function stripTags(html) {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

// --- decodeEntities: decodes the handful of HTML entities we see in article
//     bodies. Kept regex-based because DOMParser isn't available in MV3
//     service workers. ---
function decodeEntities(text) {
  if (!text) return text;
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&mdash;/g, "\u2014")
    .replace(/&ndash;/g, "\u2013")
    .replace(/&hellip;/g, "\u2026")
    .replace(/&rsquo;/g, "\u2019")
    .replace(/&lsquo;/g, "\u2018")
    .replace(/&rdquo;/g, "\u201D")
    .replace(/&ldquo;/g, "\u201C")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

// --- extractMetaDescription: returns og:description or <meta name="description">
//     content from the raw HTML, if present. ---
function extractMetaDescription(html) {
  const patterns = [
    /<meta[^>]+property\s*=\s*["']og:description["'][^>]+content\s*=\s*["']([^"']+)["']/i,
    /<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]+property\s*=\s*["']og:description["']/i,
    /<meta[^>]+name\s*=\s*["']description["'][^>]+content\s*=\s*["']([^"']+)["']/i,
    /<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]+name\s*=\s*["']description["']/i,
    /<meta[^>]+property\s*=\s*["']twitter:description["'][^>]+content\s*=\s*["']([^"']+)["']/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) return decodeEntities(m[1]);
  }
  return null;
}

// --- callAI: sends the prompt to the Cloudflare Worker proxy ---
async function callAI(headline, content, fetchError, mode) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  const prompt = buildPrompt(headline, content, fetchError, mode);

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
//     `mode` is "short" (default) or "detailed" (triggered by the user
//     clicking the "More context" button in the popup). `fetchError` is
//     non-null when we couldn't load article text — the model then answers
//     from general knowledge. ---
function buildPrompt(headline, content, fetchError, mode) {
  const isDetailed = mode === "detailed";

  // Never redirect the user back to the article; never lecture; never
  // editorialize. These rules are shared by every variant of the prompt.
  const RULES = `HARD CONSTRAINTS:
- Never tell the reader to "read the article", "visit the site", "for more information", "do your own research", "check the link", "open the original", or anything similar. The user came here specifically to NOT do that.
- Never say "I can't access", "I don't have access", "I'm unable to", or anything similar. Just answer with what you know.
- No editorializing. No opinions. No labeling anything as "clickbait", "bait", "misleading", "sensational", or similar judgmental terms. Report facts only.
- No political commentary. No personal recommendations.
- No "according to the article" or "the article says" filler.`;

  if (!content) {
    // Headline-only mode: the model has no article text to work with.
    if (isDetailed) {
      return `You are NoBait. You could not fetch the article text for this headline. Answer it from your general knowledge in 4-6 sentences, covering: the specific fact the headline teases, relevant background and context, any related numbers or names, and any caveats. If the topic is newer than your training data, say so briefly in one sentence but still give whatever useful context you have.

${RULES}

Headline: "${headline}"

Response:`;
    }

    return `You are NoBait. You could not fetch the article text for this headline. Answer the headline from your general knowledge using the rules below.

${RULES}

ANSWER STYLE — follow whichever case fits:
- Yes/No question headline ("Can you X by doing Y?", "Is X doing Y?"): start with "Yes" or "No", then one short clarifying phrase if needed. Do not write a paragraph.
- Headline teases a single name, place, price, rank, number, or short noun ("The #1 city to visit is…", "The actor who…"): answer with JUST that noun or 2-3 words. Do not pad it into a full sentence.
- Otherwise: answer in at most 1-2 tight factual sentences with concrete specifics.

Never restate the headline. If the topic is newer than your training data, say so in one short sentence.

Headline: "${headline}"

Response:`;
  }

  if (isDetailed) {
    return `You are NoBait. You have the full article text. Write a 4-6 sentence detailed summary that gives the reader: (1) the specific answer to what the headline was teasing, (2) the concrete facts and numbers from the article, (3) meaningful context and background, (4) any caveats or unknowns the article itself mentions.

${RULES}

Headline: "${headline}"

Article content:
${content}

Response:`;
  }

  return `You are NoBait. You have the article text. Give the reader the specific concrete information the headline was teasing, using the rules below.

${RULES}

ANSWER STYLE — follow whichever case fits:
- Yes/No question headline ("Can you X by doing Y?", "Is X doing Y?"): start with "Yes" or "No", then one short clarifying phrase with the key specific from the article if needed. Do not write a paragraph.
- Headline teases a single name, place, price, rank, number, or short noun ("The #1 city to visit is…", "The actor who…", "The one trick…"): answer with JUST that noun or 2-3 words from the article. Do not pad it into a full sentence.
- Otherwise: answer in at most 2-3 tight factual sentences with concrete specifics from the article (exact dates, exact numbers, exact names, exact outcomes).

Never restate the headline. If the article only partially answers the headline (e.g. month but not day), state what IS confirmed and what is still unknown in ONE sentence. If the article contradicts the headline, say so.

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

