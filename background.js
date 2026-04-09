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
const MAX_CONTENT_LENGTH = 9000;
const MIN_CONTENT_LENGTH = 140;
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
// Jina AI's free Reader API — used as a last-resort fetch for JS-rendered SPAs
// and sites whose anti-bot blocks our direct fetch.
const JINA_READER_URL_PREFIX = "https://r.jina.ai/";
const JINA_TIMEOUT_MS = 20000;
// Internet Archive Wayback Machine — final fallback for sites that block both
// our direct fetch and Jina. Archived snapshots are plain static HTML served
// from IA's own infra, so anti-bot and JS-rendering aren't in play.
const WAYBACK_AVAIL_URL = "https://archive.org/wayback/available";
const WAYBACK_TIMEOUT_MS = 15000;

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
//     Returns ok:true with a summary when article text was fetched and the
//     AI responded. Returns ok:false when the fetch pipeline failed — we
//     deliberately do NOT fall back to a headline-only AI guess, since this
//     extension is used on breaking news and any "guess from training data"
//     would be outside the model's knowledge cutoff. ---
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

  // Fallback #1: server-side Reader API (Jina). Catches JS-rendered SPAs
  // (Tom's Guide, most modern news sites) whose direct HTML is a near-empty
  // skeleton, and sites whose bot protection blocks our direct fetch. Use
  // the decoded URL when we have one, otherwise the original — avoids
  // handing Jina the Google News redirect stub.
  const realUrl = decodeGoogleNewsUrl(url) || url;
  if (!articleText) {
    try {
      articleText = await fetchViaJinaReader(realUrl);
      if (articleText) fetchError = null;
    } catch (err) {
      // Overwrite the generic "could not extract enough text" error from
      // the direct-fetch path so the user can tell which layer failed;
      // preserve more-specific errors like "paywall" / "blocked".
      const captured = captureFetchError(err);
      if (!fetchError || fetchError.type === "fetch_failed") fetchError = captured;
    }
  }

  // Fallback #2: Wayback Machine. Catches sites that block both our direct
  // fetch and Jina (heavily paywalled sites, aggressive anti-bot). Archived
  // snapshots are plain static HTML served from IA, no anti-bot in play.
  if (!articleText) {
    try {
      articleText = await fetchViaWayback(realUrl);
      if (articleText) fetchError = null;
    } catch (err) {
      const captured = captureFetchError(err);
      if (!fetchError || fetchError.type === "fetch_failed") fetchError = captured;
    }
  }

  // If every fetch path failed, fail cleanly. We deliberately do NOT fall
  // back to a headline-only AI guess: this extension is used on breaking
  // news, so any "guess from training data" would be outside the model's
  // knowledge cutoff and would mislead the user.
  if (!articleText) {
    return {
      ok: false,
      error: "unreadable",
      message: (fetchError && fetchError.message) || "Couldn't read this article.",
      contentStatus: (fetchError && fetchError.type) || "fetch_failed",
    };
  }

  // articleText is guaranteed non-null from here on.
  try {
    const summary = await callAI(headline, articleText, mode);
    return {
      ok: true,
      summary,
      contentStatus: "ok",
      contentStatusMessage: null,
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

// --- fetchViaJinaReader: last-resort fetch that delegates to Jina AI's free
//     Reader API. Jina fetches the URL server-side with a real headless
//     browser (so JS-rendered SPAs work), strips navigation/ads, and returns
//     clean text. Used when our own direct fetch returned a thin SPA shell
//     or was blocked by anti-bot. Free tier: 200 req/min, no API key.
//     Privacy note: this sends the article URL (but not the user's cookies
//     or IP) to r.jina.ai. ---
async function fetchViaJinaReader(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JINA_TIMEOUT_MS);

  // Jina accepts the target URL either unencoded (prepended as-is) or
  // percent-encoded; we encode to be safe with query strings and fragments.
  let response;
  try {
    response = await fetch(JINA_READER_URL_PREFIX + encodeURIComponent(url), {
      signal: controller.signal,
      headers: {
        "Accept": "text/plain, text/markdown, */*",
        "X-Return-Format": "text",
      },
    });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === "AbortError") {
      throw createError("fetch_failed", "Reader API took too long to respond.");
    }
    throw createError("fetch_failed", "Reader API request failed.");
  }

  clearTimeout(timer);

  if (!response.ok) {
    throw createError(
      response.status === 429 ? "blocked" : "fetch_failed",
      "Reader API returned HTTP " + response.status + "."
    );
  }

  let text = (await response.text()) || "";
  // Collapse whitespace and truncate to the same budget as extractText().
  text = text.replace(/\s+/g, " ").trim();
  if (!text) {
    throw createError("fetch_failed", "Reader API returned empty content.");
  }
  if (text.length > MAX_CONTENT_LENGTH) {
    text = text.substring(0, MAX_CONTENT_LENGTH) + "...";
  }
  if (text.length < MIN_CONTENT_LENGTH) {
    throw createError("fetch_failed", "Reader API returned too little text.");
  }
  return text;
}

// --- fetchViaWayback: final-resort fallback via the Internet Archive's
//     Wayback Machine. Step 1 queries the availability API for the closest
//     snapshot; step 2 fetches the raw archived HTML (using the id_ suffix
//     so IA doesn't inject its own toolbar/navigation); step 3 runs our
//     regular extractText() over the archived HTML. Works for paywalled
//     and anti-bot-blocked sites because IA has an archived copy already,
//     served as plain static HTML from archive.org's own infrastructure. ---
async function fetchViaWayback(url) {
  // Step 1: look up the closest snapshot via the availability API.
  const availController = new AbortController();
  const availTimer = setTimeout(() => availController.abort(), WAYBACK_TIMEOUT_MS);
  let availJson;
  try {
    const availResponse = await fetch(
      WAYBACK_AVAIL_URL + "?url=" + encodeURIComponent(url),
      { signal: availController.signal, headers: { "Accept": "application/json" } }
    );
    clearTimeout(availTimer);
    if (!availResponse.ok) {
      throw createError("fetch_failed", "Wayback availability check failed (HTTP " + availResponse.status + ").");
    }
    availJson = await availResponse.json();
  } catch (err) {
    clearTimeout(availTimer);
    if (err && err.errorType) throw err;
    if (err && err.name === "AbortError") {
      throw createError("fetch_failed", "Wayback availability check timed out.");
    }
    throw createError("fetch_failed", "Wayback availability check failed.");
  }

  const snapshot =
    availJson &&
    availJson.archived_snapshots &&
    availJson.archived_snapshots.closest;
  if (!snapshot || !snapshot.available || !snapshot.url) {
    throw createError("fetch_failed", "No Wayback snapshot available for this article.");
  }

  // Convert the standard snapshot URL into the "raw" form by inserting `id_`
  // after the timestamp. Example:
  //   https://web.archive.org/web/20250101000000/https://example.com/
  //   → https://web.archive.org/web/20250101000000id_/https://example.com/
  // This suppresses IA's toolbar injection so our extractText() sees the
  // unmodified original page.
  let snapshotUrl = snapshot.url;
  const m = snapshotUrl.match(/^(https?:\/\/web\.archive\.org\/web\/\d+)(\/https?:\/\/)/);
  if (m) snapshotUrl = m[1] + "id_" + m[2];

  // Step 2: fetch the archived HTML directly and run extraction.
  const htmlController = new AbortController();
  const htmlTimer = setTimeout(() => htmlController.abort(), FETCH_TIMEOUT_MS);
  let html;
  try {
    const htmlResponse = await fetch(snapshotUrl, {
      signal: htmlController.signal,
      redirect: "follow",
      headers: {
        "User-Agent": BROWSER_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    clearTimeout(htmlTimer);
    if (!htmlResponse.ok) {
      throw createError("fetch_failed", "Wayback snapshot fetch failed (HTTP " + htmlResponse.status + ").");
    }
    html = await htmlResponse.text();
  } catch (err) {
    clearTimeout(htmlTimer);
    if (err && err.errorType) throw err;
    if (err && err.name === "AbortError") {
      throw createError("fetch_failed", "Wayback snapshot fetch timed out.");
    }
    throw createError("fetch_failed", "Wayback snapshot fetch failed.");
  }

  // Step 3: reuse our regular extractor. If the snapshot is itself a thin
  // shell (rare but possible on very new pages), this will throw and the
  // caller surfaces an unreadable-article error to the user.
  return extractText(html);
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
//       3. Walk the container in document order, capturing headings,
//          paragraphs, and list items together. This is critical for
//          listicles ("20 Best X Ranked"), where item names live in
//          <h2>/<h3>/<li> and <p>-only extraction would miss them and
//          force the AI to hallucinate the list.
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

  // Walk headings + paragraphs + list items in document order so we
  // preserve listicle structure (item title in <h2>, blurb in <p>).
  let text = extractContentBlocks(container);

  // If structured extraction was thin, fall back to stripping tags from
  // the container to at least get raw text.
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
    throw createError("fetch_failed", "Couldn't read this article.");
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

// --- extractContentBlocks: walks the container in document order and
//     captures headings (h1-h6), paragraphs (<p>), and list items (<li>).
//     Headings are tagged with a "## " prefix so the AI can recognize the
//     structure of listicles ("## 20. Nevermind by Nirvana", "Released in
//     1991, ..."). Paragraphs are still length-filtered to skip captions,
//     but headings and list items are kept short because that's exactly
//     where listicle item titles live. ---
function extractContentBlocks(html) {
  const out = [];
  // Match h1-h6, p, and li, capturing the tag name and inner HTML.
  const re = /<(h[1-6]|p|li)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[1].toLowerCase();
    const inner = stripTags(m[2]);
    if (!inner) continue;
    if (tag === "p") {
      // Skip very short paragraphs (captions, ad disclaimers, byline cruft).
      if (inner.length < 40) continue;
      out.push(inner);
    } else if (tag === "li") {
      // Keep list items even when short — listicles often use <li> for
      // numbered entries like "Nevermind — Nirvana (1991)".
      if (inner.length < 3) continue;
      out.push(inner);
    } else {
      // Heading: prefix with "## " so the AI sees structure rather than
      // a wall of text. Drop empty / single-char headings.
      if (inner.length < 2) continue;
      out.push("## " + inner);
    }
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
async function callAI(headline, content, mode) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  const prompt = buildPrompt(headline, content, mode);

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
//     clicking the "More context" button in the popup). `content` is
//     guaranteed non-null: callers only invoke the AI path when article
//     text was successfully fetched. ---
function buildPrompt(headline, content, mode) {
  const isDetailed = mode === "detailed";

  // Never redirect the user back to the article; never lecture; never
  // editorialize. These rules are shared by every variant of the prompt.
  const RULES = `HARD CONSTRAINTS:
- ONLY use facts that appear verbatim in the "Article content" block below. Do NOT use general knowledge, training data, or guesses. If the article doesn't contain the specific answer the headline teases, say so in one short sentence (e.g. "The article doesn't list the specific items.") and stop. NEVER fabricate names, dates, numbers, ranks, or quotes that are not present in the article content.
- Never tell the reader to "read the article", "visit the site", "for more information", "do your own research", "check the link", "open the original", or anything similar. The user came here specifically to NOT do that.
- Never say "I can't access", "I don't have access", "I'm unable to", or anything similar. Just answer with what is in the article content.
- No editorializing. No opinions. No labeling anything as "clickbait", "bait", "misleading", "sensational", or similar judgmental terms. Report facts only.
- No political commentary. No personal recommendations.
- No "according to the article" or "the article says" filler.
- Headings in the article content are marked with "## " — treat them as section/item titles. They are part of the article, not metadata.`;

  if (isDetailed) {
    return `You are NoBait. The full article text is provided below. Write a 4-6 sentence detailed summary that gives the reader: (1) the specific answer to what the headline was teasing, (2) the concrete facts, names, and numbers FROM THE ARTICLE, (3) meaningful context and background that is present in the article, (4) any caveats or unknowns the article itself mentions. If the headline teases a ranked list, enumerate as many ranked items as the article actually contains (use a numbered list), then stop.

${RULES}

Headline: "${headline}"

Article content:
${content}

Response:`;
  }

  return `You are NoBait. The article text is provided below. Give the reader the specific concrete information the headline was teasing, drawn ONLY from the article content. Follow the rules below.

${RULES}

ANSWER STYLE — follow whichever case fits:
- Yes/No question headline ("Can you X by doing Y?", "Is X doing Y?"): start with "Yes" or "No", then one short clarifying phrase with the key specific from the article if needed. Do not write a paragraph.
- Headline teases a single name, place, price, rank, number, or short noun ("The #1 city to visit is…", "The actor who…", "The one trick…"): answer with JUST that noun or 2-3 words from the article. Do not pad it into a full sentence.
- Headline teases a ranked or numbered list ("The 20 greatest X, ranked", "Top 10 Y", "The 5 best Z"): return a numbered list of the items the article actually contains, in the article's order. For each item, give the item name plus any short identifying detail the article includes (year, artist, location, etc.) — one item per line. Include as many items as fit; if the article has more items than you can include, end the list with "...and more in the full article." Do NOT pad with items not in the article. Do NOT invent items from general knowledge.
- Otherwise: answer in at most 2-3 tight factual sentences with concrete specifics from the article (exact dates, exact numbers, exact names, exact outcomes).

Never restate the headline. If the article only partially answers the headline (e.g. month but not day), state what IS confirmed and what is still unknown in ONE sentence. If the article contradicts the headline, say so. If the article content does not actually contain the answer (for example it's an index page, a paywall stub, or unrelated content), say "The article doesn't include that information." in ONE sentence and stop — do NOT guess.

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

