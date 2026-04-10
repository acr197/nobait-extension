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
// Wayback Machine availability API — used to find an archived snapshot when
// the live article can't be fetched. Returns a closest-snapshot URL we can
// then feed back through the normal fetchArticle pipeline.
const WAYBACK_AVAILABILITY_URL = "https://archive.org/wayback/available";
const WAYBACK_TIMEOUT_MS = 15000;
// Archive.today — tertiary archive service. Often succeeds on paywalled or
// Cloudflare-protected sites that Wayback doesn't cover (NYT, WSJ, Bloomberg
// sometimes). The /newest/ URL pattern redirects to the latest snapshot.
const ARCHIVE_TODAY_URL = "https://archive.ph/newest/";
const ARCHIVE_TODAY_TIMEOUT_MS = 15000;
// Search-based retrieval — when no direct/Jina/Wayback fetch works, we run
// a web search for the headline and try to fetch the matching result. Bing
// HTML is used because it ships real anchors in static HTML (no JS required)
// and is lenient about scraping. DuckDuckGo HTML is a secondary mirror.
const BING_SEARCH_URL = "https://www.bing.com/search";
const DUCKDUCKGO_SEARCH_URL = "https://html.duckduckgo.com/html/";
const SEARCH_TIMEOUT_MS = 15000;
const MAX_SEARCH_CANDIDATES = 4;

// --- Message listener: routes SUMMARIZE requests from the content script
//     and the sidebar. Returns a Promise so the same handler works in Chrome
//     (MV3) and Firefox. ---
api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === "SUMMARIZE") {
    const mode = msg.mode === "detailed" ? "detailed" : "short";
    const responsePromise = handleSummarize(msg.url, msg.headline, mode).catch((err) => ({
      ok: false,
      error: "ai_error",
      message: "An unexpected error occurred.",
      debug: [{
        t: 0,
        stage: "uncaught",
        status: "fail",
        detail: (err && err.message) || String(err),
        data: null,
      }],
    }));
    responsePromise.then((res) => {
      try { sendResponse(res); } catch (_) { /* channel may be closed in Firefox */ }
    });
    return responsePromise;
  }

  if (msg.type === "ALTERNATE_SOURCE") {
    const responsePromise = handleAlternateSource(msg.url, msg.headline).catch((err) => ({
      ok: false,
      error: "alt_error",
      message: "An unexpected error occurred.",
      debug: [{
        t: 0,
        stage: "uncaught",
        status: "fail",
        detail: (err && err.message) || String(err),
        data: null,
      }],
    }));
    responsePromise.then((res) => {
      try { sendResponse(res); } catch (_) { /* channel may be closed in Firefox */ }
    });
    return responsePromise;
  }
});

// --- handleSummarize: orchestrates fetch -> extract -> AI pipeline.
//     Returns ok:true with a summary in two modes:
//       1. Article fetched + AI summarized → summary grounded in article text
//       2. Article couldn't be fetched → AI answers from web search /
//          training knowledge, same as pasting "headline + publisher" into
//          Claude.ai / ChatGPT. The popup labels this answer clearly so the
//          user can distinguish it from article-grounded answers.
//
//     Every response (ok or not) carries a `debug` array — a timestamped log
//     of every fetch attempt, extraction result, and AI call. Debug mode in
//     the popup renders it as a diagnostic panel under the summary so the
//     user can see exactly which fallback ran, which stage failed, and copy
//     the entries back into Claude Code for investigation. ---
async function handleSummarize(url, headline, mode) {
  const debug = createDebugLog();
  debug.log("start", "info", "begin summarize", {
    url,
    headline,
    mode,
  });

  let articleText = null;
  let articleSource = null; // label for the fetcher that succeeded
  let fetchError = null;

  // Google News URLs: /articles/ and /read/ pages are JS-redirect stubs that
  // don't contain article text themselves. Resolve the real publisher URL first
  // (via base64 decode, HTTP redirect follow, or RSS feed parsing), then fetch
  // the publisher article directly. This avoids ever extracting text from the
  // Google News stub page and ensures Jina/Wayback get the publisher URL too.
  let realUrl = url;
  const googleNewsRss = buildGoogleNewsRssUrl(url);

  if (googleNewsRss) {
    debug.log("google_news", "info", "Google News stub detected, resolving publisher URL");
    let publisherUrl = decodeGoogleNewsUrl(url);
    if (publisherUrl) {
      debug.log("google_news", "ok", "decoded from base64 article id", { publisherUrl });
    } else {
      publisherUrl = await discoverPublisherUrl(googleNewsRss);
      if (publisherUrl) {
        debug.log("google_news", "ok", "resolved via RSS redirect", { publisherUrl });
      } else {
        debug.log("google_news", "fail", "could not resolve publisher URL");
      }
    }
    if (publisherUrl) {
      realUrl = publisherUrl;
      debug.log("direct_fetch", "info", "fetching resolved publisher URL", { url: publisherUrl });
      try {
        articleText = await fetchArticle(publisherUrl);
        articleSource = "direct_fetch(google_news_resolved)";
        fetchError = null;
        debug.log("direct_fetch", "ok", `got ${articleText.length} chars`, {
          length: articleText.length,
          preview: previewText(articleText),
        });
      } catch (err) {
        fetchError = captureFetchError(err);
        debug.log("direct_fetch", "fail", fetchError.message, {
          errorType: fetchError.type,
        });
      }
    }
  }

  // Standard path: fetch the requested URL directly.
  // For Google News where publisher URL couldn't be resolved this also attempts
  // the stub URL — fetch() follows HTTP redirects automatically, so it may
  // still land on the publisher article via server-side 302.
  if (!articleText) {
    debug.log("direct_fetch", "info", "attempting direct fetch", { url });
    try {
      articleText = await fetchArticle(url);
      articleSource = "direct_fetch";
      fetchError = null;
      debug.log("direct_fetch", "ok", `got ${articleText.length} chars`, {
        length: articleText.length,
        preview: previewText(articleText),
      });
    } catch (err) {
      const captured = captureFetchError(err);
      if (!fetchError) fetchError = captured;
      debug.log("direct_fetch", "fail", captured.message, {
        errorType: captured.type,
      });
    }
  }

  // Fallback #1: server-side Reader API (Jina). Catches JS-rendered SPAs
  // (Tom's Guide, most modern news sites) whose direct HTML is a near-empty
  // skeleton, and sites whose bot protection blocks our direct fetch.
  // For Google News, realUrl is already the resolved publisher URL.
  if (!articleText) {
    debug.log("jina_reader", "info", "attempting Jina Reader API", { url: realUrl });
    try {
      articleText = await fetchViaJinaReader(realUrl);
      if (articleText) {
        articleSource = "jina_reader";
        fetchError = null;
        debug.log("jina_reader", "ok", `got ${articleText.length} chars`, {
          length: articleText.length,
          preview: previewText(articleText),
        });
      }
    } catch (err) {
      // Overwrite the generic "could not extract enough text" error from
      // the direct-fetch path so the user can tell which layer failed;
      // preserve more-specific errors like "paywall" / "blocked".
      const captured = captureFetchError(err);
      if (!fetchError || fetchError.type === "fetch_failed") fetchError = captured;
      debug.log("jina_reader", "fail", captured.message, {
        errorType: captured.type,
      });
    }
  }

  // Fallback #2: Wayback Machine. When direct fetch and Jina both fail
  // (paywall, anti-bot, JS SPA that doesn't render for headless fetchers),
  // archive.org usually has a static snapshot that's trivially readable.
  if (!articleText) {
    debug.log("wayback", "info", "attempting Wayback Machine", { url: realUrl });
    try {
      articleText = await fetchViaWayback(realUrl);
      if (articleText) {
        articleSource = "wayback";
        fetchError = null;
        debug.log("wayback", "ok", `got ${articleText.length} chars`, {
          length: articleText.length,
          preview: previewText(articleText),
        });
      }
    } catch (err) {
      const captured = captureFetchError(err);
      if (!fetchError || fetchError.type === "fetch_failed") fetchError = captured;
      debug.log("wayback", "fail", captured.message, {
        errorType: captured.type,
      });
    }
  }

  // Fallback #3: Archive.today (archive.ph). Often succeeds on paywalled or
  // Cloudflare-protected sites that Wayback doesn't cover. Separate from
  // Wayback because the two services have largely non-overlapping snapshot
  // coverage.
  if (!articleText) {
    debug.log("archive_today", "info", "attempting Archive.today", { url: realUrl });
    try {
      articleText = await fetchViaArchiveToday(realUrl);
      if (articleText) {
        articleSource = "archive_today";
        fetchError = null;
        debug.log("archive_today", "ok", `got ${articleText.length} chars`, {
          length: articleText.length,
          preview: previewText(articleText),
        });
      }
    } catch (err) {
      const captured = captureFetchError(err);
      if (!fetchError || fetchError.type === "fetch_failed") fetchError = captured;
      debug.log("archive_today", "fail", captured.message, {
        errorType: captured.type,
      });
    }
  }

  // Fallback #4: search-based retrieval. This is the same trick Claude.ai
  // and ChatGPT use internally — search the web for the exact headline,
  // then read the top result. Different URL (sometimes a different
  // publisher's coverage of the same story), but the content is still
  // real reporting rather than an AI guess. This rescues JS-rendered SPAs
  // that Jina can't render and sites without archive snapshots.
  if (!articleText) {
    debug.log("search", "info", "attempting search-based retrieval", {
      headline,
      originalUrl: realUrl,
    });
    try {
      articleText = await fetchViaSearchResults(headline, realUrl);
      if (articleText) {
        articleSource = "search_result";
        fetchError = null;
        debug.log("search", "ok", `got ${articleText.length} chars from a search result`, {
          length: articleText.length,
          preview: previewText(articleText),
        });
      }
    } catch (err) {
      const captured = captureFetchError(err);
      if (!fetchError || fetchError.type === "fetch_failed") fetchError = captured;
      debug.log("search", "fail", captured.message, {
        errorType: captured.type,
      });
    }
  }

  // Fallback #5: ask the AI as if the user had pasted the headline + publisher
  // into Claude.ai / ChatGPT. The AI uses web search (if available) or its
  // training knowledge to answer. We flag the response with source:"knowledge"
  // so the popup can show the user that the answer is NOT from the article.
  if (!articleText) {
    debug.log("ai_knowledge", "info", "all fetch paths failed, asking AI from knowledge");
    try {
      const summary = await callAISearch(headline, realUrl, mode);
      debug.log("ai_knowledge", "ok", `AI returned ${summary.length} chars`, {
        length: summary.length,
      });
      debug.log("done", "info", "returning knowledge-source summary");
      return {
        ok: true,
        summary,
        source: "knowledge",
        contentStatus: "from_knowledge",
        contentStatusMessage:
          "Article couldn't be fetched — this answer is from AI knowledge.",
        debug: debug.entries,
      };
    } catch (err) {
      debug.log("ai_knowledge", "fail", err.message || "AI knowledge call failed");
      // If even the search-style AI call fails, surface the original fetch
      // error (which is usually more actionable than an AI timeout).
      debug.log("done", "fail", "all paths exhausted");
      return {
        ok: false,
        error: "unreadable",
        message: (fetchError && fetchError.message) || err.message || "Couldn't read this article.",
        contentStatus: (fetchError && fetchError.type) || "fetch_failed",
        debug: debug.entries,
      };
    }
  }

  // articleText is guaranteed non-null from here on.
  debug.log("ai_summarize", "info", `calling AI with content from ${articleSource}`, {
    contentLength: articleText.length,
    mode,
  });
  try {
    const summary = await callAI(headline, articleText, mode);
    debug.log("ai_summarize", "ok", `AI returned ${summary.length} chars`, {
      length: summary.length,
    });
    debug.log("done", "ok", "returning article-grounded summary");
    return {
      ok: true,
      summary,
      source: "article",
      contentStatus: "ok",
      contentStatusMessage: null,
      debug: debug.entries,
    };
  } catch (err) {
    debug.log("ai_summarize", "fail", err.message || "AI call failed");
    debug.log("done", "fail", "AI error after fetch");
    return {
      ok: false,
      error: "ai_error",
      message: err.message || "Summarization failed.",
      debug: debug.entries,
    };
  }
}

// --- createDebugLog: returns a small logger object used by handleSummarize
//     (and handleAlternateSource) to record a timestamped trace of every
//     fetch attempt and AI call. The debug array is attached to every
//     response so the popup can render it under the summary when debug
//     mode is on. ---
function createDebugLog() {
  const start = Date.now();
  const entries = [];
  return {
    entries,
    log(stage, status, detail, data) {
      entries.push({
        t: Date.now() - start,
        stage,
        status: status || "info",
        detail: detail || "",
        data: data || null,
      });
    },
  };
}

// --- previewText: short prefix of fetched article text, used in debug
//     entries so the user can see whether the extractor actually pulled
//     real article prose or just navigation/footer junk. ---
function previewText(text) {
  if (!text) return "";
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length > 200 ? trimmed.substring(0, 200) + "…" : trimmed;
}

// --- handleAlternateSource: finds, fetches, and summarizes a different
//     publisher's article on the same headline. Used by the "Alternate
//     source" popup button when the user wants a second-opinion summary
//     from a different outlet. Returns:
//       { ok:true, title, publisher, date, url, summary }  on success
//       { ok:false, error, message }                       on failure
//     Strategy:
//       1. Search Bing/DDG for the exact headline.
//       2. Filter out the original publisher and aggregator domains, keep
//          the most recent-looking news candidates.
//       3. Race the top candidates through the standard fetch pipeline.
//       4. Extract title, published date, and article text from the winner.
//       5. Summarize via callAI in short mode. ---
async function handleAlternateSource(originalUrl, headline) {
  const debug = createDebugLog();
  debug.log("alt_start", "info", "begin alternate source lookup", {
    originalUrl,
    headline,
  });

  if (!headline) {
    debug.log("alt_start", "fail", "no headline provided");
    return {
      ok: false,
      error: "no_headline",
      message: "Need a headline to find an alternate source.",
      debug: debug.entries,
    };
  }

  // Find candidate URLs from a different publisher.
  let candidates;
  try {
    candidates = await findAlternateCandidates(headline, originalUrl);
    debug.log("alt_search", "ok", `found ${candidates.length} candidate(s)`, {
      candidates,
    });
  } catch (err) {
    debug.log("alt_search", "fail", "search engine error");
    return {
      ok: false,
      error: "search_failed",
      message: "Couldn't search for alternate sources.",
      debug: debug.entries,
    };
  }

  if (!candidates || candidates.length === 0) {
    debug.log("alt_search", "fail", "no candidates after filtering");
    return {
      ok: false,
      error: "no_alternates",
      message: "No alternate sources found for this story.",
      debug: debug.entries,
    };
  }

  // Try each candidate sequentially. Sequential rather than parallel because
  // we want the FIRST working result (which Bing/DDG already rank by relevance
  // & recency), not the fastest race winner.
  let lastError = null;
  for (const candidate of candidates) {
    debug.log("alt_fetch", "info", "trying candidate", { url: candidate });
    try {
      const article = await fetchAlternateArticle(candidate);
      if (!article || !article.text) {
        debug.log("alt_fetch", "fail", "candidate returned no text", { url: candidate });
        continue;
      }
      debug.log("alt_fetch", "ok", `got ${article.text.length} chars`, {
        url: candidate,
        length: article.text.length,
        title: article.title || null,
        preview: previewText(article.text),
      });
      debug.log("ai_summarize", "info", "calling AI on alternate article");
      const summary = await callAI(article.title || headline, article.text, "short");
      debug.log("ai_summarize", "ok", `AI returned ${summary.length} chars`);
      debug.log("done", "ok", "returning alternate summary");
      return {
        ok: true,
        title: article.title || headline,
        publisher: getPublisherFromUrl(candidate),
        date: article.date || null,
        url: candidate,
        summary,
        debug: debug.entries,
      };
    } catch (err) {
      lastError = err;
      debug.log("alt_fetch", "fail", (err && err.message) || "candidate failed", {
        url: candidate,
      });
    }
  }

  debug.log("done", "fail", "all candidates exhausted");
  return {
    ok: false,
    error: "fetch_failed",
    message: (lastError && lastError.message) || "Couldn't fetch any alternate source.",
    debug: debug.entries,
  };
}

// --- findAlternateCandidates: same search infrastructure as
//     fetchViaSearchResults, but filters OUT the original publisher (we
//     want a different outlet) and includes more candidates so we have
//     more chances to find one that's fetchable. ---
async function findAlternateCandidates(headline, originalUrl) {
  const quoted = '"' + headline.replace(/"/g, "") + '"';

  let candidates = [];
  try {
    const bingHtml = await fetchSearchEngineHtml(BING_SEARCH_URL + "?q=" + encodeURIComponent(quoted));
    candidates = candidates.concat(parseBingResults(bingHtml));
  } catch (_) { /* try DDG */ }

  try {
    const ddgHtml = await fetchSearchEngineHtml(DUCKDUCKGO_SEARCH_URL + "?q=" + encodeURIComponent(quoted));
    candidates = candidates.concat(parseDuckDuckGoResults(ddgHtml));
  } catch (_) { /* ignore */ }

  const originalKey = canonicalizeForCompare(originalUrl);
  const originalPublisher = getPublisherFromUrl(originalUrl);
  const seen = new Set();
  const filtered = [];

  for (const candidate of candidates) {
    const key = canonicalizeForCompare(candidate);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (key === originalKey) continue;
    if (isBlockedSearchHost(candidate)) continue;
    // Skip same publisher — we want a different outlet's coverage.
    const candidatePublisher = getPublisherFromUrl(candidate);
    if (candidatePublisher && originalPublisher && candidatePublisher === originalPublisher) continue;
    filtered.push(candidate);
    if (filtered.length >= 6) break;
  }
  return filtered;
}

// --- fetchAlternateArticle: fetches a single candidate URL, extracts the
//     article text + title + published date. Reuses fetchArticle's pipeline
//     but also captures the raw HTML one extra time so we can parse out
//     metadata that extractText discards. ---
async function fetchAlternateArticle(url) {
  // Fetch raw HTML so we can pull title/date/body all from the same payload.
  let raw;
  try {
    raw = await fetchRaw(url, BROWSER_UA);
  } catch (err) {
    if (err.errorType === "paywall" || err.errorType === "blocked") {
      try { raw = await fetchRaw(url, GOOGLEBOT_UA); } catch (_) { /* fall through */ }
    }
  }

  if (raw && raw.html) {
    // Follow JS/meta redirect stubs once.
    const redirect = extractJsRedirect(raw.html, raw.finalUrl || url);
    if (redirect && redirect !== (raw.finalUrl || url)) {
      try {
        const text = await fetchArticle(redirect);
        return {
          title: extractTitle(raw.html) || null,
          date: extractPublishedDate(raw.html) || null,
          text,
        };
      } catch (_) { /* fall through to local extraction */ }
    }

    if (!looksLikeAntiBot(raw.html) && !looksLikePaywall(raw.html)) {
      try {
        const text = extractText(raw.html);
        return {
          title: extractTitle(raw.html),
          date: extractPublishedDate(raw.html),
          text,
        };
      } catch (_) { /* fall through to Jina */ }
    }
  }

  // Fallback: Jina Reader. We lose direct access to the title/date metadata,
  // but Jina returns clean text that's good enough to summarize.
  const text = await fetchViaJinaReader(url);
  return { title: null, date: null, text };
}

// --- extractTitle: returns the article title from <title>, og:title, or
//     twitter:title meta tags. Falls back to the first <h1>. ---
function extractTitle(html) {
  if (!html) return null;
  const ogMatch = html.match(/<meta[^>]+property\s*=\s*["']og:title["'][^>]+content\s*=\s*["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]+property\s*=\s*["']og:title["']/i);
  if (ogMatch && ogMatch[1]) return decodeEntities(ogMatch[1]).trim();
  const twMatch = html.match(/<meta[^>]+name\s*=\s*["']twitter:title["'][^>]+content\s*=\s*["']([^"']+)["']/i);
  if (twMatch && twMatch[1]) return decodeEntities(twMatch[1]).trim();
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch && titleMatch[1]) {
    // Remove the publisher suffix like "Article Name - The Publisher".
    let title = decodeEntities(stripTags(titleMatch[1])).trim();
    title = title.replace(/\s*[\|\-—–·]\s*[^|\-—–·]{2,40}$/, "").trim();
    if (title) return title;
  }
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match && h1Match[1]) return decodeEntities(stripTags(h1Match[1])).trim();
  return null;
}

// --- extractPublishedDate: returns a human-readable published date string.
//     Tries multiple sources in order: JSON-LD datePublished, article:published_time,
//     <time datetime="">, then various meta tags. Returns null if nothing found. ---
function extractPublishedDate(html) {
  if (!html) return null;

  // 1. JSON-LD datePublished (most reliable).
  const ldRe = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = ldRe.exec(html)) !== null) {
    try {
      const data = JSON.parse(m[1].trim());
      const date = findDatePublishedInJsonLd(data);
      if (date) return formatDate(date);
    } catch (_) { /* skip */ }
  }

  // 2. <meta property="article:published_time" content="...">
  const metaPatterns = [
    /<meta[^>]+property\s*=\s*["']article:published_time["'][^>]+content\s*=\s*["']([^"']+)["']/i,
    /<meta[^>]+name\s*=\s*["']article:published_time["'][^>]+content\s*=\s*["']([^"']+)["']/i,
    /<meta[^>]+name\s*=\s*["']pubdate["'][^>]+content\s*=\s*["']([^"']+)["']/i,
    /<meta[^>]+name\s*=\s*["']publishdate["'][^>]+content\s*=\s*["']([^"']+)["']/i,
    /<meta[^>]+name\s*=\s*["']publish_date["'][^>]+content\s*=\s*["']([^"']+)["']/i,
    /<meta[^>]+name\s*=\s*["']date["'][^>]+content\s*=\s*["']([^"']+)["']/i,
    /<meta[^>]+itemprop\s*=\s*["']datePublished["'][^>]+content\s*=\s*["']([^"']+)["']/i,
  ];
  for (const re of metaPatterns) {
    const match = html.match(re);
    if (match && match[1]) {
      const formatted = formatDate(match[1]);
      if (formatted) return formatted;
    }
  }

  // 3. <time datetime="..."> element.
  const timeMatch = html.match(/<time[^>]+datetime\s*=\s*["']([^"']+)["']/i);
  if (timeMatch && timeMatch[1]) {
    const formatted = formatDate(timeMatch[1]);
    if (formatted) return formatted;
  }
  return null;
}

// --- findDatePublishedInJsonLd: recursively walks parsed JSON-LD looking
//     for any datePublished string field. ---
function findDatePublishedInJsonLd(obj, depth) {
  depth = depth || 0;
  if (!obj || depth > 6) return null;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const date = findDatePublishedInJsonLd(item, depth + 1);
      if (date) return date;
    }
    return null;
  }
  if (typeof obj !== "object") return null;
  if (typeof obj.datePublished === "string") return obj.datePublished;
  if (Array.isArray(obj["@graph"])) {
    const date = findDatePublishedInJsonLd(obj["@graph"], depth + 1);
    if (date) return date;
  }
  for (const key in obj) {
    const val = obj[key];
    if (val && typeof val === "object") {
      const date = findDatePublishedInJsonLd(val, depth + 1);
      if (date) return date;
    }
  }
  return null;
}

// --- formatDate: turns an ISO-8601 or similar date string into a short
//     human-readable form ("Feb 9, 2026"). Returns null on parse failure. ---
function formatDate(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  if (isNaN(d.getTime())) return null;
  try {
    return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  } catch (_) {
    return d.toISOString().substring(0, 10);
  }
}

// --- isGoogleDomain: returns true for google.com and Google-owned CDN/asset
//     domains that will never host publisher articles. ---
function isGoogleDomain(hostname) {
  const h = hostname.toLowerCase();
  return /(?:^|\.)(?:google\.com|googleusercontent\.com|gstatic\.com|ggpht\.com|googleapis\.com)$/.test(h);
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

// --- discoverPublisherUrl: follows the redirect chain of a Google News RSS
//     stub URL and returns the final publisher article URL. Two strategies:
//     1. HTTP redirect: if fetch() lands on a non-Google domain, return it.
//     2. RSS body parse: if the response stays on google.com (e.g. the RSS
//        endpoint returned feed XML rather than redirecting), read the body
//        and extract the publisher <link> from the feed. Returns null on any
//        error or if no publisher URL can be found. ---
async function discoverPublisherUrl(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": BROWSER_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml,application/rss+xml,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    clearTimeout(timer);
    const finalUrl = resp.url;
    if (!finalUrl) return null;
    let parsed;
    try { parsed = new URL(finalUrl); } catch (_) { return null; }
    // If HTTP redirect landed on a non-Google domain, we're done.
    if (!isGoogleDomain(parsed.hostname)) return finalUrl;
    // Still on google.com — parse the response body as RSS/Atom to find the
    // publisher link (handles cases where the RSS endpoint returns feed XML
    // instead of issuing a 302 redirect to the article).
    try {
      const body = await resp.text();
      return extractRssArticleLink(body);
    } catch (_) { return null; }
  } catch (_) {
    clearTimeout(timer);
    return null;
  }
}

// --- extractRssArticleLink: scans RSS 2.0 / Atom feed XML for the first
//     publisher article URL (any <link> text content or href attribute that
//     points to a non-google.com domain). ---
function extractRssArticleLink(xml) {
  if (!xml) return null;
  // RSS 2.0: <link>https://publisher.com/path</link>
  const rssRe = /<link[^>]*>(https?:\/\/[^\s<]+)<\/link>/gi;
  let m;
  while ((m = rssRe.exec(xml)) !== null) {
    try {
      const u = new URL(m[1].trim());
      if (!isGoogleDomain(u.hostname)) return u.href;
    } catch (_) {}
  }
  // Atom / Google RSS extension: <link href="https://publisher.com/..." />
  const atomRe = /<link[^>]+href\s*=\s*["'](https?:\/\/[^"']+)["'][^>]*>/gi;
  while ((m = atomRe.exec(xml)) !== null) {
    try {
      const u = new URL(m[1].trim());
      if (!isGoogleDomain(u.hostname)) return u.href;
    } catch (_) {}
  }
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
    // Retry #1: Googlebot UA. Many SSR sites ship richer static HTML to crawlers.
    try {
      const retry = await fetchRaw(url, GOOGLEBOT_UA);
      const retryRedirect = extractJsRedirect(retry.html, retry.finalUrl || baseUrl);
      if (retryRedirect && retryRedirect !== (retry.finalUrl || baseUrl)) {
        return fetchArticle(retryRedirect, { depth: depth + 1 });
      }
      return extractText(retry.html);
    } catch (_) { /* fall through to AMP */ }
    // Retry #2: discover an AMP version via <link rel="amphtml"> in the HTML
    // we already fetched. AMP pages are stripped-down static HTML that's
    // trivially extractable, so this rescues many JS-heavy SSR sites.
    const ampUrl = extractAmpUrl(html, baseUrl);
    if (ampUrl && ampUrl !== baseUrl) {
      try {
        return await fetchArticle(ampUrl, { depth: depth + 1 });
      } catch (_) { /* fall through */ }
    }
    throw err;
  }
}

// --- extractAmpUrl: returns the canonical AMP URL declared by the page via
//     <link rel="amphtml" href="..."> if present. This is the standards-based
//     AMP discovery method (more reliable than guessing /amp suffixes). ---
function extractAmpUrl(html, baseUrl) {
  if (!html) return null;
  const match = html.match(
    /<link[^>]+rel\s*=\s*["']amphtml["'][^>]+href\s*=\s*["']([^"']+)["']/i
  ) || html.match(
    /<link[^>]+href\s*=\s*["']([^"']+)["'][^>]+rel\s*=\s*["']amphtml["']/i
  );
  if (!match) return null;
  try {
    return new URL(match[1], baseUrl || undefined).href;
  } catch (_) { return null; }
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

// --- fetchViaWayback: asks archive.org's availability API for the closest
//     snapshot of the URL, then fetches the archived HTML through the normal
//     extraction pipeline. Uses the `id_/` variant of the Wayback URL to get
//     the original un-modified page (no Wayback toolbar iframe injected). ---
async function fetchViaWayback(url) {
  if (!url) throw createError("fetch_failed", "No URL for Wayback lookup.");

  const lookupUrl = WAYBACK_AVAILABILITY_URL + "?url=" + encodeURIComponent(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WAYBACK_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(lookupUrl, {
      signal: controller.signal,
      headers: { "Accept": "application/json" },
    });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === "AbortError") {
      throw createError("fetch_failed", "Wayback Machine took too long to respond.");
    }
    throw createError("fetch_failed", "Wayback Machine request failed.");
  }
  clearTimeout(timer);

  if (!response.ok) {
    throw createError(
      "fetch_failed",
      "Wayback Machine returned HTTP " + response.status + "."
    );
  }

  let data;
  try {
    data = await response.json();
  } catch (_) {
    throw createError("fetch_failed", "Wayback Machine returned invalid JSON.");
  }

  const snapshot = data && data.archived_snapshots && data.archived_snapshots.closest;
  if (!snapshot || !snapshot.available || !snapshot.url) {
    throw createError("fetch_failed", "No Wayback snapshot found for this article.");
  }

  // Convert "/web/<ts>/" to "/web/<ts>id_/" to get the raw archived HTML
  // without the Wayback toolbar wrapper. The id_ variant is what scrapers
  // and link checkers use because it's byte-identical to the original.
  const rawSnapshotUrl = snapshot.url.replace(/\/web\/(\d+)\//, "/web/$1id_/");

  // Route through the standard article pipeline so the same extraction,
  // retries, and paywall/anti-bot detection apply.
  return fetchArticle(rawSnapshotUrl);
}

// --- fetchViaArchiveToday: requests the latest snapshot of the URL from
//     archive.ph (Archive.today). Different snapshot coverage from Wayback
//     and often succeeds on paywalled or Cloudflare-protected pages that
//     Wayback misses. The /newest/ path issues a 302 to the actual snapshot
//     page, which fetch() follows automatically. We then strip the Archive
//     toolbar markup and route through the standard extractor. ---
async function fetchViaArchiveToday(url) {
  if (!url) throw createError("fetch_failed", "No URL for Archive.today lookup.");

  const snapshotUrl = ARCHIVE_TODAY_URL + url;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ARCHIVE_TODAY_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(snapshotUrl, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": BROWSER_UA,
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === "AbortError") {
      throw createError("fetch_failed", "Archive.today took too long to respond.");
    }
    throw createError("fetch_failed", "Archive.today request failed.");
  }
  clearTimeout(timer);

  if (!response.ok) {
    throw createError(
      "fetch_failed",
      "Archive.today returned HTTP " + response.status + "."
    );
  }

  // If we landed back on archive.ph search page rather than a snapshot,
  // there's no archived copy of this URL.
  const finalUrl = response.url || snapshotUrl;
  if (/\/newest\//.test(finalUrl) || /^https?:\/\/archive\.ph\/?$/.test(finalUrl)) {
    throw createError("fetch_failed", "No Archive.today snapshot for this article.");
  }

  const html = await response.text();
  if (!html || html.length < 500) {
    throw createError("fetch_failed", "Archive.today returned empty content.");
  }

  return extractText(html);
}

// --- fetchViaSearchResults: runs a web search for the headline (optionally
//     scoped to the publisher) and tries to fetch the matching result. This
//     mirrors what the user would get by pasting the headline into Claude.ai
//     or ChatGPT — the AI searches the web and reads the top result.
//
//     Strategy:
//       1. Query Bing's static-HTML search endpoint (lenient, no JS required).
//          If Bing is blocked/empty, fall back to DuckDuckGo HTML.
//       2. Parse the result URLs out of the response HTML.
//       3. Skip the original URL (already tried) and any obvious non-article
//          domains (social media, aggregators).
//       4. For each of the top N candidates, run fetchArticle(). Return the
//          first one that yields enough text.
//       5. If no candidate fetches cleanly, fall back to Jina Reader on the
//          top candidate so we still get SOMETHING real. ---
async function fetchViaSearchResults(headline, originalUrl) {
  if (!headline) throw createError("fetch_failed", "No headline for search lookup.");

  // Build a tight query. Quoting the headline greatly improves precision;
  // most news headlines are long enough that an exact-phrase match returns
  // the original article or a direct reprint as the first hit.
  const quoted = '"' + headline.replace(/"/g, "") + '"';
  const publisher = originalUrl ? getPublisherFromUrl(originalUrl) : "";
  const query = publisher ? quoted + " " + publisher : quoted;

  // Try Bing first, then DuckDuckGo. Collect the union of candidate URLs
  // — a broken parser on one engine shouldn't starve us of results.
  let candidates = [];
  try {
    const bingHtml = await fetchSearchEngineHtml(BING_SEARCH_URL + "?q=" + encodeURIComponent(query));
    candidates = candidates.concat(parseBingResults(bingHtml));
  } catch (_) { /* try next engine */ }

  if (candidates.length < MAX_SEARCH_CANDIDATES) {
    try {
      const ddgHtml = await fetchSearchEngineHtml(DUCKDUCKGO_SEARCH_URL + "?q=" + encodeURIComponent(query));
      candidates = candidates.concat(parseDuckDuckGoResults(ddgHtml));
    } catch (_) { /* ignore */ }
  }

  // Dedupe by hostname+path and filter out the original URL and non-article
  // domains (video, social, aggregators) that never have useful text.
  const seen = new Set();
  const originalKey = canonicalizeForCompare(originalUrl);
  const filtered = [];
  for (const candidate of candidates) {
    const key = canonicalizeForCompare(candidate);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (key === originalKey) continue;
    if (isBlockedSearchHost(candidate)) continue;
    filtered.push(candidate);
    if (filtered.length >= MAX_SEARCH_CANDIDATES) break;
  }

  if (filtered.length === 0) {
    throw createError("fetch_failed", "Search returned no usable results.");
  }

  // Race candidates in parallel: first successful fetch wins. Each attempt
  // tries direct fetch, then Jina Reader for JS-rendered pages. Using
  // Promise.any keeps wall-clock latency bounded to a single fetch round,
  // which matters because this path runs after three prior fallbacks.
  const attempts = filtered.map((candidate) => tryReadCandidate(candidate));
  try {
    return await Promise.any(attempts);
  } catch (aggregate) {
    // Promise.any throws AggregateError when every attempt failed.
    const firstErr = aggregate && aggregate.errors && aggregate.errors[0];
    throw firstErr || createError("fetch_failed", "Couldn't read any search result.");
  }
}

// --- tryReadCandidate: attempts to read a single search-result URL, first
//     via direct fetch, then via Jina Reader. Resolves with the text on
//     success; rejects if both paths fail (so Promise.any can skip it). ---
async function tryReadCandidate(candidate) {
  try {
    const text = await fetchArticle(candidate);
    if (text && text.length >= MIN_CONTENT_LENGTH) return text;
  } catch (_) { /* fall through to Jina */ }
  const text = await fetchViaJinaReader(candidate);
  if (text && text.length >= MIN_CONTENT_LENGTH) return text;
  throw createError("fetch_failed", "Candidate returned too little text.");
}

// --- fetchSearchEngineHtml: GETs a search engine HTML page with a browser
//     UA and a tight timeout. Returns the raw HTML body. ---
async function fetchSearchEngineHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": BROWSER_UA,
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === "AbortError") {
      throw createError("fetch_failed", "Search engine took too long.");
    }
    throw createError("fetch_failed", "Search engine request failed.");
  }
  clearTimeout(timer);
  if (!response.ok) {
    throw createError("fetch_failed", "Search engine returned HTTP " + response.status + ".");
  }
  return await response.text();
}

// --- parseBingResults: extracts result URLs from a Bing search HTML page.
//     Bing ships result anchors as `<h2><a href="https://real.url/...">`
//     inside `<li class="b_algo">` items. We match the href attributes of
//     those anchors and filter to external http(s) URLs. ---
function parseBingResults(html) {
  if (!html) return [];
  const urls = [];
  // Target anchors inside b_algo items. The simpler regex catches all
  // h2 > a hrefs which in practice are organic result URLs on Bing.
  const re = /<li[^>]+class\s*=\s*["'][^"']*b_algo[^"']*["'][\s\S]*?<h2[^>]*>\s*<a[^>]+href\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = m[1];
    if (/^https?:\/\//i.test(url)) urls.push(url);
  }
  // Fallback: if Bing changed markup, grab any h2 > a href.
  if (urls.length === 0) {
    const fb = /<h2[^>]*>\s*<a[^>]+href\s*=\s*["'](https?:\/\/[^"']+)["']/gi;
    let m2;
    while ((m2 = fb.exec(html)) !== null) {
      urls.push(m2[1]);
    }
  }
  return urls;
}

// --- parseDuckDuckGoResults: extracts result URLs from a DuckDuckGo HTML
//     search page. DDG wraps real URLs in its own redirect
//     (//duckduckgo.com/l/?uddg=<encoded-real-url>), which we decode back
//     to the target URL. ---
function parseDuckDuckGoResults(html) {
  if (!html) return [];
  const urls = [];
  const re = /<a[^>]+class\s*=\s*["'][^"']*result__a[^"']*["'][^>]+href\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    const decoded = decodeDuckDuckGoRedirect(href);
    if (decoded && /^https?:\/\//i.test(decoded)) urls.push(decoded);
  }
  return urls;
}

// --- decodeDuckDuckGoRedirect: turns "//duckduckgo.com/l/?uddg=..." into
//     the underlying target URL. If the href is already a direct URL,
//     returns it as-is. URLSearchParams.get() already performs percent-
//     decoding, so we return the value as-is. ---
function decodeDuckDuckGoRedirect(href) {
  try {
    // DDG hrefs are protocol-relative: prefix with https: to parse.
    const full = href.startsWith("//") ? "https:" + href : href;
    const u = new URL(full);
    if (u.hostname.endsWith("duckduckgo.com") && u.searchParams.has("uddg")) {
      return u.searchParams.get("uddg");
    }
    return u.href;
  } catch (_) {
    return null;
  }
}

// --- canonicalizeForCompare: returns a stable "host + path" key used to
//     dedupe candidate URLs and to skip the original article URL when
//     iterating search results. ---
function canonicalizeForCompare(url) {
  if (!url) return "";
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const path = u.pathname.replace(/\/+$/, "").toLowerCase();
    return host + path;
  } catch (_) {
    return "";
  }
}

// --- isBlockedSearchHost: returns true for hosts that never carry useful
//     article text (video platforms, social media, aggregators). Skipping
//     them frees up candidate slots for real news sources. ---
function isBlockedSearchHost(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const blocked = [
      "youtube.com", "youtu.be", "m.youtube.com",
      "twitter.com", "x.com", "t.co",
      "facebook.com", "m.facebook.com",
      "instagram.com", "tiktok.com",
      "reddit.com", "linkedin.com", "pinterest.com",
      "news.google.com", "bing.com", "duckduckgo.com",
    ];
    return blocked.some((b) => host === b || host.endsWith("." + b));
  } catch (_) {
    return true;
  }
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
  const short = lower.length < 8000;
  // Hard-gate phrases that only appear on paywall/subscribe walls
  const hardGates = [
    "subscribe to continue",
    "subscribe to read",
    "subscribe to unlock",
    "start a subscription",
    "this post is for paid subscribers",
    "this article is for paid subscribers",
    "this content is for subscribers",
    "exclusive to subscribers",
    "for members only",
    "become a member to read",
    "create a free account to read",
    "sign up to read",
    "register to read",
  ];
  for (const phrase of hardGates) {
    if (lower.includes(phrase)) return true;
  }
  // Softer phrases: only flag on short pages (full articles may mention
  // "subscribe" in footers without being paywalled)
  if (short) {
    if (lower.includes("to continue reading") && lower.includes("subscribe")) return true;
    if (lower.includes("already a subscriber") && lower.includes("sign in")) return true;
    if (lower.includes("subscriber-only") || lower.includes("members only")) return true;
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
//     Strategy (in order, first one that produces enough text wins):
//       1. JSON-LD structured data (schema.org Article.articleBody). This is
//          the gold standard — standardized, SEO-required, embedded in most
//          modern news sites (NYT, Reuters, Guardian, WordPress via Yoast).
//       2. Next.js __NEXT_DATA__ JSON blob — recursively walk for article
//          body fields. Critical for Next.js sites like Cracked whose HTML
//          shell is thin but whose JSON payload is full.
//       3. Class/id-based container detection — div/section with known
//          article body classes (entry-content, article-body, story-body,
//          etc.) — more reliable than guessing from <article>/<main>.
//       4. <article>/<main> tag detection (legacy fallback).
//       5. Strip scripts/nav/footer/etc. and extract all remaining <p>, <h*>,
//          <li>, <blockquote> in document order. Preserves listicle structure.
//       6. Strip-all fallback + meta description last resort. ---
function extractText(html) {
  if (!html) throw createError("fetch_failed", "No HTML to extract.");

  // Strategy 1: JSON-LD structured data (before we strip scripts).
  const jsonLdBody = extractJsonLdArticleBody(html);
  if (jsonLdBody && jsonLdBody.length >= MIN_CONTENT_LENGTH) {
    return finalizeArticleText(jsonLdBody, html);
  }

  // Strategy 2: __NEXT_DATA__ / embedded JSON (before we strip scripts).
  const nextDataBody = extractEmbeddedJsonArticleBody(html);
  if (nextDataBody && nextDataBody.length >= MIN_CONTENT_LENGTH) {
    return finalizeArticleText(nextDataBody, html);
  }

  // Strip non-content blocks for DOM-style extraction.
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
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, " ");

  // Strategy 3 + 4: Try known article container classes/ids first, then
  // <article>/<main> tags as fallback.
  const container = extractArticleContainer(cleaned) || cleaned;

  // Walk headings + paragraphs + list items + blockquotes in document order.
  let text = extractContentBlocks(container);

  // Strategy 5: Strip tags from container as raw-text fallback.
  if (!text || text.length < MIN_CONTENT_LENGTH) {
    text = stripTags(container);
  }

  text = decodeEntities(text).replace(/\s+/g, " ").trim();

  // Strategy 6: meta description as absolute last resort.
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

// --- finalizeArticleText: normalizes text extracted via structured data
//     paths (JSON-LD, __NEXT_DATA__). Strips any HTML the field may contain,
//     decodes entities, collapses whitespace, and truncates to budget. ---
function finalizeArticleText(raw, originalHtml) {
  let text = raw;
  // articleBody / JSON content fields sometimes contain HTML markup.
  if (/<[a-z][^>]*>/i.test(text)) {
    // Preserve structure: convert headings to "## " markers, line-break lists,
    // then strip everything else. Reuses the same content-block walker.
    const walked = extractContentBlocks(text);
    text = (walked && walked.length >= MIN_CONTENT_LENGTH) ? walked : stripTags(text);
  }
  text = decodeEntities(text).replace(/\s+/g, " ").trim();
  // Prepend the headline/title from the page if we can find one, since some
  // JSON articleBody fields don't include the headline.
  if (text.length > MAX_CONTENT_LENGTH) {
    text = text.substring(0, MAX_CONTENT_LENGTH) + "...";
  }
  if (text.length < MIN_CONTENT_LENGTH) {
    throw createError("fetch_failed", "Structured article body was too short.");
  }
  return text;
}

// --- extractJsonLdArticleBody: parses every <script type="application/ld+json">
//     block in the HTML and returns the articleBody string from the first
//     Article-typed node it finds. Handles @graph arrays, array roots, and
//     multi-type Article variants (NewsArticle, BlogPosting, etc.). ---
function extractJsonLdArticleBody(html) {
  const ARTICLE_TYPES = [
    "Article", "NewsArticle", "BlogPosting", "ReportageNewsArticle",
    "OpinionNewsArticle", "AnalysisNewsArticle", "LiveBlogPosting",
    "BackgroundNewsArticle", "ReviewNewsArticle",
  ];
  const re = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let jsonText = m[1].trim();
    // Some CMSes wrap the JSON in HTML comments (<!-- -->).
    jsonText = jsonText.replace(/^<!--/, "").replace(/-->$/, "").trim();
    if (!jsonText) continue;
    let data;
    try {
      data = JSON.parse(jsonText);
    } catch (_) {
      // Try decoding HTML entities then re-parsing.
      try {
        data = JSON.parse(decodeEntities(jsonText));
      } catch (_) { continue; }
    }
    const body = findArticleBodyInJsonLd(data, ARTICLE_TYPES);
    if (body && body.length >= MIN_CONTENT_LENGTH) return body;
  }
  return null;
}

// --- findArticleBodyInJsonLd: recursively searches a parsed JSON-LD object
//     for a node whose @type is an Article variant and returns its
//     articleBody. Handles @graph arrays and nested objects. ---
function findArticleBodyInJsonLd(obj, articleTypes, depth) {
  depth = depth || 0;
  if (!obj || depth > 6) return null;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const body = findArticleBodyInJsonLd(item, articleTypes, depth + 1);
      if (body) return body;
    }
    return null;
  }
  if (typeof obj !== "object") return null;
  // @graph pattern: object with a @graph array of entities.
  if (Array.isArray(obj["@graph"])) {
    const body = findArticleBodyInJsonLd(obj["@graph"], articleTypes, depth + 1);
    if (body) return body;
  }
  // Check if this node is an Article type.
  let type = obj["@type"];
  if (Array.isArray(type)) type = type.find((t) => articleTypes.indexOf(t) !== -1) || type[0];
  if (type && articleTypes.indexOf(type) !== -1) {
    if (typeof obj.articleBody === "string" && obj.articleBody.length > 200) {
      return obj.articleBody;
    }
  }
  // Recurse into nested values that are objects/arrays (breadth-limited).
  for (const key in obj) {
    const val = obj[key];
    if (val && typeof val === "object") {
      const body = findArticleBodyInJsonLd(val, articleTypes, depth + 1);
      if (body) return body;
    }
  }
  return null;
}

// --- extractEmbeddedJsonArticleBody: parses <script id="__NEXT_DATA__">,
//     <script id="__NUXT_DATA__">, and similar embedded JSON blobs used by
//     modern JS frameworks, then recursively walks the object looking for
//     the longest string that looks like article content. Critical for
//     Cracked.com (Next.js) and other React/Vue/Svelte sites whose rendered
//     HTML is too thin for DOM-style extraction. ---
function extractEmbeddedJsonArticleBody(html) {
  const patterns = [
    /<script[^>]+id\s*=\s*["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
    /<script[^>]+id\s*=\s*["']__NUXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
    /<script[^>]+id\s*=\s*["']__APOLLO_STATE__["'][^>]*>([\s\S]*?)<\/script>/i,
    /<script[^>]+id\s*=\s*["']__INITIAL_STATE__["'][^>]*>([\s\S]*?)<\/script>/i,
  ];
  for (const re of patterns) {
    const match = html.match(re);
    if (!match) continue;
    const jsonText = match[1].trim();
    if (!jsonText) continue;
    let data;
    try {
      data = JSON.parse(jsonText);
    } catch (_) {
      try { data = JSON.parse(decodeEntities(jsonText)); } catch (_) { continue; }
    }
    const body = findLongestArticleContent(data);
    if (body && body.length >= MIN_CONTENT_LENGTH) return body;
  }
  return null;
}

// --- findLongestArticleContent: walks a parsed JSON tree looking for the
//     longest string value that sits under a key like "body", "content",
//     "articleBody", "html", etc. and contains enough sentence punctuation
//     to look like prose. Depth-limited to keep the walker cheap. ---
function findLongestArticleContent(obj) {
  const CONTENT_KEYS = new Set([
    "articlebody", "body", "content", "html", "bodyhtml", "contenthtml",
    "richtext", "text", "raw", "post_content", "postcontent", "contentrendered",
    "renderedcontent", "fulltext", "plaintext", "description",
  ]);
  let best = "";
  function walk(node, parentKey, depth) {
    if (!node || depth > 10) return;
    if (typeof node === "string") {
      if (!parentKey) return;
      if (!CONTENT_KEYS.has(parentKey.toLowerCase())) return;
      if (node.length < 300) return;
      // Strip HTML tags if present to measure real text length.
      const stripped = /<[a-z][^>]*>/i.test(node) ? stripTags(node) : node;
      if (stripped.length < 200) return;
      // Must look like prose: has sentence-ending punctuation with a space.
      if (!/[.!?]\s/.test(stripped)) return;
      if (stripped.length > best.length) best = node; // keep original (with HTML)
      return;
    }
    if (typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, parentKey, depth + 1);
      return;
    }
    for (const key in node) {
      walk(node[key], key, depth + 1);
    }
  }
  walk(obj, null, 0);
  return best || null;
}

// --- extractArticleContainer: returns the inner HTML of the most likely
//     main content container. Tries known article class/id patterns first,
//     then falls back to <article>/<main> tags. Class-based detection covers
//     sites whose article body lives in a plain <div> (Cracked, Vox, etc.). ---
function extractArticleContainer(html) {
  // Common article body container classes/ids, ordered by specificity.
  // Sourced from WordPress, Vox, NYT, Reuters, Guardian, BBC, etc.
  const CLASS_PATTERNS = [
    "entry-content", "article-body", "articleBody", "post-content",
    "story-body", "storyBody", "article-content", "post-body", "story-content",
    "main-content", "c-entry-content", "RichTextStoryBody", "ArticleBody-articleBody",
    "content__article-body", "body-copy", "article__body", "article__content",
    "td-post-content", "post__content", "articleContent", "article-text",
    "entry__content", "single-content", "article-inner",
  ];
  let best = null;
  for (const cls of CLASS_PATTERNS) {
    const container = findElementByAttr(html, cls);
    if (container && container.length > 400 && (!best || container.length > best.length)) {
      best = container;
    }
  }
  // Legacy fallback: <article> / <main> tags.
  if (!best || best.length < 600) {
    const articleRe = /<article\b[\s\S]*?<\/article>/gi;
    let m;
    while ((m = articleRe.exec(html)) !== null) {
      if (!best || m[0].length > best.length) best = m[0];
    }
    const mainMatch = html.match(/<main\b[\s\S]*?<\/main>/i);
    if (mainMatch && (!best || mainMatch[0].length > best.length)) {
      best = mainMatch[0];
    }
  }
  // itemprop="articleBody" (microdata) — spans any tag.
  if (!best || best.length < 600) {
    const itemMatch = html.match(/<(\w+)[^>]+itemprop\s*=\s*["']articleBody["'][^>]*>/i);
    if (itemMatch) {
      const inner = findElementByStartIndex(html, itemMatch.index, itemMatch[1]);
      if (inner && inner.length > 400 && (!best || inner.length > best.length)) {
        best = inner;
      }
    }
  }
  return best && best.length > 400 ? best : null;
}

// --- findElementByAttr: given an HTML string and a class/id substring,
//     finds the first opening <div|section|article|main> tag whose class
//     or id attribute contains that substring, then returns the element's
//     full outerHTML by counting nested tags to locate the matching close.
//     Regex-only (no DOM), but nest-aware. ---
function findElementByAttr(html, needle) {
  // Match any opening block-level tag containing class="...needle..." or id="...needle..."
  const re = new RegExp(
    "<(div|section|article|main)\\b[^>]*(?:class|id)\\s*=\\s*[\"'][^\"']*\\b" +
      needle.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&") +
      "\\b[^\"']*[\"'][^>]*>",
    "i"
  );
  const match = re.exec(html);
  if (!match) return null;
  return findElementByStartIndex(html, match.index, match[1]);
}

// --- findElementByStartIndex: walks forward from a tag start index counting
//     open/close tags of the same name until it finds the matching close.
//     Handles self-closing tags and nested elements. Returns the outerHTML
//     substring or null if the element can't be balanced. ---
function findElementByStartIndex(html, startIdx, tagName) {
  const lcName = tagName.toLowerCase();
  const openRe = new RegExp("<" + lcName + "\\b", "gi");
  const closeRe = new RegExp("</" + lcName + "\\s*>", "gi");
  // Start scanning just after the opening tag.
  let scanFrom = html.indexOf(">", startIdx);
  if (scanFrom < 0) return null;
  scanFrom += 1;
  let depth = 1;
  openRe.lastIndex = scanFrom;
  closeRe.lastIndex = scanFrom;
  // Cap the search to avoid pathological regex runtime on huge pages.
  const MAX_SCAN = Math.min(html.length, startIdx + 200000);
  while (depth > 0) {
    openRe.lastIndex = Math.max(openRe.lastIndex, scanFrom);
    closeRe.lastIndex = Math.max(closeRe.lastIndex, scanFrom);
    const openMatch = openRe.exec(html);
    const closeMatch = closeRe.exec(html);
    if (!closeMatch || closeMatch.index >= MAX_SCAN) return null;
    if (openMatch && openMatch.index < closeMatch.index && openMatch.index < MAX_SCAN) {
      depth++;
      scanFrom = openMatch.index + lcName.length + 1;
    } else {
      depth--;
      scanFrom = closeMatch.index + closeMatch[0].length;
      if (depth === 0) return html.substring(startIdx, scanFrom);
    }
  }
  return null;
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
  // Match h1-h6, p, li, and blockquote, capturing the tag name and inner HTML.
  // blockquote is included to capture embedded tweet text (pre-hydration Twitter
  // embeds appear as <blockquote class="twitter-tweet"><p>...</p></blockquote>).
  const re = /<(h[1-6]|p|li|blockquote)\b[^>]*>([\s\S]*?)<\/\1>/gi;
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
    } else if (tag === "blockquote") {
      // Capture quoted content including tweet text. Skip trivially short ones.
      if (inner.length < 15) continue;
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
    return `You are NoBait. The full article text is provided below. Write a 4-6 sentence detailed summary that gives the reader: (1) the specific answer to what the headline was teasing, (2) the concrete facts, names, and numbers FROM THE ARTICLE, (3) meaningful context and background that is present in the article, (4) any caveats or unknowns the article itself mentions. If the headline teases a ranked list, enumerate up to 10 ranked items from the article (use a numbered list). If the article contains more than 10, add "That's the most this summary can list." after the 10th.

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
- Headline teases a ranked or numbered list ("The 20 greatest X, ranked", "Top 10 Y", "The 5 best Z"): return a numbered list of the items the article actually contains, in the article's order, up to a maximum of 10. For each item, give the item name plus any short identifying detail the article includes (year, artist, location, etc.) — one item per line. If the article has more than 10 items, add exactly one short line after the 10th: "That's the most this summary can list." Do NOT pad with items not in the article. Do NOT invent items from general knowledge.
- Otherwise: answer in at most 2-3 tight factual sentences with concrete specifics from the article (exact dates, exact numbers, exact names, exact outcomes).

Never restate the headline. If the article only partially answers the headline (e.g. month but not day), state what IS confirmed and what is still unknown in ONE sentence. If the article contradicts the headline, say so. If the article content does not actually contain the answer (for example it's an index page, a paywall stub, or unrelated content), say "The article doesn't include that information." in ONE sentence and stop — do NOT guess.

Headline: "${headline}"

Article content:
${content}

Response:`;
}

// --- callAISearch: final-resort AI call used when every fetch path failed.
//     Sends the headline + publisher to the proxy and asks the model to
//     answer as if the user had pasted the headline + publisher into
//     Claude.ai / ChatGPT. The model uses web search (when available) or
//     its training knowledge. The popup surfaces a banner making it clear
//     the answer did NOT come from the fetched article. ---
async function callAISearch(headline, url, mode) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  const prompt = buildSearchPrompt(headline, url, mode);

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

// --- getPublisherFromUrl: extracts a human-readable publisher label from a
//     URL (e.g. "https://www.defector.com/articles/foo" → "defector.com").
//     Falls back to the raw hostname on any parse error. ---
function getPublisherFromUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./i, "");
  } catch (_) {
    return "";
  }
}

// --- buildSearchPrompt: mirrors buildPrompt's rules (same answer-style
//     cases, same HARD CONSTRAINTS) but swaps "use ONLY the article text"
//     for "use web search or training knowledge". This is what the user
//     would get if they pasted the headline + publisher into Claude.ai or
//     ChatGPT. ---
function buildSearchPrompt(headline, url, mode) {
  const isDetailed = mode === "detailed";
  const publisher = getPublisherFromUrl(url);
  const publisherLine = publisher ? `Publisher: ${publisher}\n` : "";
  const urlLine = url ? `URL: ${url}\n` : "";

  const RULES = `HARD CONSTRAINTS:
- If you have web search available, search for the specific article by this exact headline from this publisher, and report the concrete facts the article contains.
- If web search is unavailable, answer from your training knowledge — but ONLY if you have specific, confident knowledge of this exact article or its topic. NEVER fabricate names, dates, numbers, ranks, quotes, or list items.
- If you don't have web search and don't have confident knowledge of this specific article, say "I don't have specific information about this article." in ONE sentence and stop. Do NOT guess.
- Never tell the reader to "read the article", "visit the site", "check the link", "for more information", "do your own research", or anything similar. The user came here specifically to NOT do that.
- Never say "I can't access the internet", "I don't have access", "I'm unable to", or anything similar. If you cannot find the information, just say "I don't have specific information about this article." and stop.
- No editorializing. No opinions. No labeling anything as "clickbait", "bait", "misleading", or similar judgmental terms.
- No political commentary. No personal recommendations.
- No "according to my training data", "based on what I know", or similar meta-commentary — just answer.`;

  if (isDetailed) {
    return `You are NoBait. The extension could not fetch this news article directly. Answer the user's implicit question about what the headline teases, as if the user had pasted the headline and publisher into Claude.ai or ChatGPT. Use web search when available, otherwise use your training knowledge.

Write a 4-6 sentence detailed answer giving: (1) the specific answer to what the headline was teasing, (2) concrete facts, names, and numbers, (3) meaningful context and background, (4) any caveats or unknowns. If the headline teases a ranked list, enumerate up to 10 items as a numbered list. If there are more than 10, add "That's the most this summary can list." after the 10th.

${RULES}

Headline: "${headline}"
${publisherLine}${urlLine}
Response:`;
  }

  return `You are NoBait. The extension could not fetch this news article directly. Answer the user's implicit question about what the headline teases, as if the user had pasted the headline and publisher into Claude.ai or ChatGPT. Use web search when available, otherwise use your training knowledge.

${RULES}

ANSWER STYLE — follow whichever case fits:
- Yes/No question headline ("Can you X by doing Y?", "Is X doing Y?"): start with "Yes" or "No", then one short clarifying phrase with the key specific. Do not write a paragraph.
- Headline teases a single name, place, price, rank, number, or short noun ("The #1 city to visit is…", "The actor who…", "The one trick…"): answer with JUST that noun or 2-3 words. Do not pad it into a full sentence.
- Headline teases a ranked or numbered list ("The 20 greatest X, ranked", "Top 10 Y", "The 5 best Z"): return a numbered list of up to 10 items, in the article's order if known. For each item, give the item name plus any short identifying detail (year, artist, location, etc.) — one item per line. If there are more than 10, add exactly one short line after the 10th: "That's the most this summary can list."
- Otherwise: answer in at most 2-3 tight factual sentences with concrete specifics (exact dates, exact numbers, exact names, exact outcomes).

Never restate the headline. If you only partially know the answer, state what IS known and what is unknown in ONE sentence. If you don't have confident knowledge of this specific article, say "I don't have specific information about this article." in ONE sentence and stop.

Headline: "${headline}"
${publisherLine}${urlLine}
Response:`;
}

// --- createError: builds an Error with an errorType property ---
function createError(errorType, message) {
  const err = new Error(message);
  err.errorType = errorType;
  return err;
}

