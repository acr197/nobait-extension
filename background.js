// background.js — Service worker for NoBait
// Resolves redirect chains via: (1) no-tab fetch (RSS redirect for Google News,
// HEAD/GET for all others), (2) tab navigation fallback for JS-only redirects.

const TAB_HARD_TIMEOUT_MS = 12000;
const TAB_SETTLE_DELAY_MS = 1500;
const TAB_REDIRECTOR_SETTLE_MS = 5000;
const NOTAB_TIMEOUT_MS = 4000;

// Hostnames whose pages exist solely to JS-redirect to a publisher.
// If the tab's final URL is on one of these AND matches the original,
// we wait significantly longer for the redirect to fire — the JS isn't
// always done by the time `complete` arrives, especially on first hit.
const REDIRECTOR_HOSTS = new Set([
  "news.google.com",
  "t.co",
  "lnkd.in",
  "l.facebook.com",
  "lm.facebook.com",
  "out.reddit.com",
  "go.redirectingat.com",
]);

function isRedirectorHost(url) {
  try {
    return REDIRECTOR_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

// Extract the CBM article ID from a Google News URL.
// Handles /articles/CBM..., /rss/articles/CBM..., and /read/CBM... paths.
function extractGoogleNewsArticleId(url) {
  const match = url.match(/\/(?:rss\/articles|articles|read)\/(CBM[^/?#]+)/);
  return match ? match[1] : null;
}

// ── Strategy 1: No-tab resolver (fetch only, no background tab) ──────
// For Google News CBM URLs: fetches the RSS redirect endpoint, which does
// a plain HTTP redirect straight to the publisher article URL.
// For all other URLs: tries HEAD then GET with redirect:follow.
// Hard timeout: NOTAB_TIMEOUT_MS. Falls through to tab-navigation on failure.

async function resolveViaNoTab(originalUrl, requestId) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), NOTAB_TIMEOUT_MS);

  let url;
  try {
    url = new URL(originalUrl);
  } catch {
    clearTimeout(timeoutId);
    return null;
  }

  try {
    // Google News CBM articles — /rss/articles/{id} does a plain HTTP redirect
    // to the publisher URL, no JavaScript needed.
    if (url.hostname === "news.google.com") {
      const articleId = extractGoogleNewsArticleId(originalUrl);
      if (articleId) {
        const rssUrl = `https://news.google.com/rss/articles/${articleId}`;
        console.log(`[NoBait BG] requestId=${requestId} | noTab: trying Google News RSS redirect`);
        const resp = await fetch(rssUrl, { redirect: "follow", signal: controller.signal });
        clearTimeout(timeoutId);
        if (resp.url && resp.url !== rssUrl && !resp.url.includes("news.google.com")) {
          return { url: resp.url, method: "rss-redirect" };
        }
        console.warn(`[NoBait BG] requestId=${requestId} | noTab: RSS redirect stayed on news.google.com — falling back to tab`);
        return null;
      }
    }

    // All other URLs — try HEAD first (fast), fall back to GET on failure or 405
    try {
      const headResp = await fetch(originalUrl, {
        method: "HEAD",
        redirect: "follow",
        signal: controller.signal,
      });
      if (headResp.redirected && headResp.url !== originalUrl) {
        clearTimeout(timeoutId);
        return { url: headResp.url, method: "fetch-head" };
      }
    } catch (headErr) {
      if (headErr.name === "AbortError") {
        clearTimeout(timeoutId);
        console.warn(`[NoBait BG] requestId=${requestId} | noTab HEAD aborted by timeout`);
        return null;
      }
      // HEAD failed (405, network error) — continue to GET
      console.warn(`[NoBait BG] requestId=${requestId} | noTab HEAD failed (${headErr.message}), trying GET`);
    }

    const getResp = await fetch(originalUrl, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (getResp.url !== originalUrl) {
      return { url: getResp.url, method: "fetch-get" };
    }

    return null;

  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") {
      console.warn(`[NoBait BG] requestId=${requestId} | noTab timed out after ${NOTAB_TIMEOUT_MS}ms — falling back to tab`);
    } else {
      console.warn(`[NoBait BG] requestId=${requestId} | noTab error: ${err.message}`);
    }
    return null;
  }
}

// ── Clickbait answer config ──────────────────────────────────────────
// The Worker is shared with the original NoBait extension. It holds the
// OPENAI_API_KEY secret and fronts api.openai.com/v1/responses (gpt-4o-mini).
const NOBAIT_WORKER_URL = "https://nobait-proxy.acr197.workers.dev/summarize";
const ARTICLE_FETCH_TIMEOUT_MS = 8000;
const AI_TIMEOUT_MS = 12000;
const ARTICLE_MAX_CHARS = 4000;
const ANSWER_MAX_CHARS = 220;
// Bump when the prompt changes so debug dumps can be correlated with
// answer quality. Old cached answers are evicted by URL+TTL, not version,
// but the version is recorded in the meta payload pushed to the tooltip.
const PROMPT_VERSION = "v5-2026-04-26";
const BEST_GUESS_MAX_CHARS = 440;
const EXPANDED_MAX_CHARS = 500;
// Punchline (style="punchline") returns bare-fragment answers — much
// tighter cap than the standard 220-char prose summary.
const PUNCHLINE_MAX_CHARS = 100;
const ARCHIVE_AVAIL_TIMEOUT_MS = 5000;

// Alt-source caps. Each attempt costs at most one URL resolve + one fetch +
// (only on success) one AI call. Five hard-cap keeps token spend bounded
// when every candidate is paywalled — worst case is 5 fetches + 0 AI calls.
const ALT_SOURCE_MAX_ATTEMPTS = 5;
const ALT_SOURCE_SEARCH_TIMEOUT_MS = 8000;
const ALT_SOURCE_GN_QUICK_TIMEOUT_MS = 4000;

// ── Settings (popup-controlled fallback toggles) ─────────────────────
// Each fallback now has TWO booleans:
//   enabled: show as a button in the long-click tooltip
//   auto:    also run automatically as part of the fallback chain
// `auto` requires `enabled` (popup enforces this).
//
// Defaults match popup.js. Backward compat: if the stored value is a bare
// boolean (legacy "auto-run only"), it's lifted to { enabled: true, auto: <bool> }.
const SETTINGS_KEY = "nobaitSettings";
const DEFAULT_FALLBACKS = {
  jsonLd:    { enabled: true,  auto: false },
  metaDesc:  { enabled: true,  auto: false },
  cookies:   { enabled: false, auto: false },
  amp:       { enabled: false, auto: false },
  twelveFt:  { enabled: false, auto: false },
  altSource: { enabled: true,  auto: false },
  archive:   { enabled: false, auto: false },
  google:    { enabled: false, auto: false },
  ddg:       { enabled: false, auto: false },
  debugInfo: { enabled: false, auto: false },
};

function normalizeFallbackEntry(stored, def) {
  if (stored === true) return { enabled: true, auto: true };
  if (stored === false) return { enabled: def.enabled, auto: false };
  if (stored && typeof stored === "object") {
    return {
      enabled: stored.enabled !== undefined ? !!stored.enabled : def.enabled,
      auto: stored.auto !== undefined ? !!stored.auto : def.auto,
    };
  }
  return { enabled: def.enabled, auto: def.auto };
}

const VALID_STYLES = new Set(["standard", "punchline"]);
const DEFAULT_STYLE = "standard";

async function getSettings() {
  try {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    const raw = stored[SETTINGS_KEY] || {};
    const fb = raw.fallbacks || {};
    const merged = {
      summaryStyle: VALID_STYLES.has(raw.summaryStyle) ? raw.summaryStyle : DEFAULT_STYLE,
      fallbacks: {},
    };
    for (const [k, def] of Object.entries(DEFAULT_FALLBACKS)) {
      merged.fallbacks[k] = normalizeFallbackEntry(fb[k], def);
    }
    return merged;
  } catch (err) {
    console.warn("[NoBait BG] settings load failed, using defaults:", err.message);
    return {
      summaryStyle: DEFAULT_STYLE,
      fallbacks: JSON.parse(JSON.stringify(DEFAULT_FALLBACKS)),
    };
  }
}

// Pushes a one-line status update to the tooltip while a long fallback
// chain is running. Content swaps it into the loading area.
function sendProgress(tabId, requestId, status) {
  if (typeof tabId !== "number") return;
  chrome.tabs
    .sendMessage(tabId, { type: "progress-update", requestId, status })
    .catch(() => {});
  console.log(`[NoBait BG] requestId=${requestId} | progress: ${status}`);
}

// Pushes a granular debug event to the in-popup debug log — DOES NOT
// update the visible loading status. Used for per-attempt alt source
// events, fallback chain decisions, and other diagnostics that should
// be visible in Copy Debug but not flicker the status text.
function sendDebugEvent(tabId, requestId, level, message) {
  if (typeof tabId !== "number") return;
  chrome.tabs
    .sendMessage(tabId, { type: "debug-event", requestId, level: level || "INFO", message })
    .catch(() => {});
  const tag = level === "WARN" ? "warn" : level === "ERROR" ? "error" : "log";
  console[tag](`[NoBait BG] requestId=${requestId} | ${message}`);
}

// ── Block detection config ───────────────────────────────────────────
// Hostnames known to require subscription. The list is conservative —
// only sites that hard-paywall most articles. Detection still runs text
// markers as a backstop for unlisted publishers.
const PAYWALLED_DOMAINS = new Set([
  "ft.com",
  "nytimes.com",
  "wsj.com",
  "washingtonpost.com",
  "economist.com",
  "bloomberg.com",
  "businessinsider.com",
  "theatlantic.com",
  "newyorker.com",
  "vanityfair.com",
  "wired.com",
  "thetimes.co.uk",
  "telegraph.co.uk",
  "theathletic.com",
  "theinformation.com",
  "axios.com",
  "seekingalpha.com",
  "barrons.com",
  "hbr.org",
  "foreignaffairs.com",
  "foreignpolicy.com",
  "ft.co.uk",
  "nymag.com",
  "vulture.com",
  "thecut.com",
  "qz.com",
  "scientificamerican.com",
  "nature.com",
  "sciencemag.org",
  "newscientist.com",
  "ftalphaville.ft.com",
]);

// Pattern fragments (lowercased) that strongly suggest the page body is
// a paywall interstitial rather than an article. Two or more matches
// inside a short body are treated as confirming a paywall.
const PAYWALL_TEXT_MARKERS = [
  "subscribe to unlock",
  "subscribe to read",
  "subscribers only",
  "subscriber-only",
  "this article is for subscribers",
  "sign in to continue reading",
  "sign in to read",
  "create a free account to continue",
  "become a member",
  "try unlimited access",
  "keep reading for $",
  "subscribe now to continue",
  "to read this article",
  "monthly subscription",
  "unlock this article",
];

// HTML/text fragments that indicate a bot-protection challenge or
// outright server-side block. Detected regardless of HTTP status.
const BOT_BLOCK_MARKERS = [
  "just a moment...",
  "checking your browser",
  "cf-browser-verification",
  "attention required! | cloudflare",
  "ddos protection by cloudflare",
  "are you a robot",
  "please verify you are human",
  "access denied",
  "request unsuccessful. incapsula",
  "akamai reference",
];

// Examines URL, HTTP status, raw HTML, and extracted text together to
// classify a fetch as paywall, bot-block, or clean. Returns null when
// the article looks fetchable normally.
// Output: { kind: 'paywall'|'bot-block', reason, publisher?, detectedFrom? }
function detectBlock(url, httpStatus, html, text) {
  const lowHtml = (html || "").toLowerCase();
  const lowText = (text || "").toLowerCase();

  // ── Bot-block first: HTTP status ──────────────────────────────────
  if (httpStatus === 401 || httpStatus === 403 || httpStatus === 451) {
    return {
      kind: "bot-block",
      reason: `HTTP ${httpStatus} from publisher`,
    };
  }
  if (httpStatus === 429) {
    return { kind: "bot-block", reason: "HTTP 429 (rate limited)" };
  }
  if (httpStatus === 503 && lowHtml.includes("cloudflare")) {
    return { kind: "bot-block", reason: "HTTP 503 + Cloudflare wrapper" };
  }

  // ── Bot-block: HTML markers ───────────────────────────────────────
  for (const marker of BOT_BLOCK_MARKERS) {
    if (lowHtml.includes(marker)) {
      return { kind: "bot-block", reason: `Marker: "${marker}"` };
    }
  }

  // ── Paywall: known domain ─────────────────────────────────────────
  let hostname = null;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {}
  if (hostname) {
    for (const domain of PAYWALLED_DOMAINS) {
      if (hostname === domain || hostname.endsWith("." + domain)) {
        return { kind: "paywall", publisher: domain };
      }
    }
  }

  // ── Paywall: text markers ─────────────────────────────────────────
  // Count how many markers appear in the extracted text, but cap the scan
  // at 3 so we don't spend time on long articles that contain one membership
  // appeal inside otherwise-real content (FanGraphs, The Athletic free tier,
  // etc.). The body-length thresholds prevent false positives:
  //   3+ markers         → always paywall (overwhelming signal)
  //   2  markers, < 2000 → paywall (soft paywall with thin body)
  //   1  marker,  < 1200 → paywall (strong single marker in thin body)
  //   1+ markers, ≥ 1200 → NOT paywalled — real article present even if
  //                         a subscription appeal is embedded in the page.
  const textLen = (text || "").length;
  let markerHits = 0;
  let firstMarker = null;
  for (const marker of PAYWALL_TEXT_MARKERS) {
    if (lowText.includes(marker)) {
      markerHits += 1;
      if (!firstMarker) firstMarker = marker;
      if (markerHits >= 3) break;
    }
  }
  const isPaywallByMarker =
    markerHits >= 3 ||
    (markerHits >= 2 && textLen < 2000) ||
    (markerHits >= 1 && textLen < 1200);

  if (isPaywallByMarker) {
    return {
      kind: "paywall",
      publisher: hostname || "unknown",
      detectedFrom: firstMarker,
    };
  }

  return null;
}

// Decodes HTML entities — both named (&amp;, &quot;, &nbsp;, etc.) and
// numeric (decimal &#39; and hex &#x27;). Critical for headlines pulled
// from <title> / og:title that ship apostrophes as &#x27; — without this
// the search query "John&#x27;s article" gets sent verbatim and zero results.
function decodeHtmlEntities(text) {
  if (!text) return "";
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return _; }
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      try { return String.fromCodePoint(parseInt(dec, 10)); } catch { return _; }
    })
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&mdash;/gi, "—")
    .replace(/&ndash;/gi, "–")
    .replace(/&hellip;/gi, "…")
    .replace(/&lsquo;/gi, "‘")
    .replace(/&rsquo;/gi, "’")
    .replace(/&ldquo;/gi, "“")
    .replace(/&rdquo;/gi, "”");
}

// Best-effort article title extraction from HTML metadata. Falls back
// through og:title → twitter:title → <title>. Strips trailing publisher
// suffixes like " | NYT" or " - Financial Times" so the title is usable
// as a search query. Returns trimmed string or null.
function extractArticleTitle(html) {
  if (!html) return null;
  const patterns = [
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i,
    /<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i,
    /<title>([^<]{5,300})<\/title>/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) {
      let t = decodeHtmlEntities(m[1]).replace(/\s+/g, " ").trim();
      // Strip common " | Publisher" or " - Publisher" suffixes.
      t = t.replace(/\s*[|·•—–-]\s*[^|·•—–-]{2,40}$/, "").trim();
      if (t.length > 5) return t;
    }
  }
  return null;
}

// ── Fallback extractors (free, run on already-fetched HTML) ─────────

// Pulls article body text from JSON-LD schema blocks. Many publishers ship
// the full body in <script type="application/ld+json"> for SEO crawlers,
// even on paywalled pages. Returns text or null.
function extractJsonLdBody(html) {
  if (!html) return null;
  const blockRegex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  let best = null;
  while ((m = blockRegex.exec(html)) !== null) {
    let raw = m[1].trim();
    // Some sites ship CDATA or HTML entities — clean a bit.
    raw = raw.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { continue; }
    // Could be a single object or an array of @graph nodes
    const nodes = [];
    const collect = (n) => {
      if (!n) return;
      if (Array.isArray(n)) { n.forEach(collect); return; }
      if (typeof n !== "object") return;
      nodes.push(n);
      if (n["@graph"]) collect(n["@graph"]);
    };
    collect(parsed);
    for (const node of nodes) {
      const t = node && node["@type"];
      const isArticle =
        t === "NewsArticle" ||
        t === "Article" ||
        t === "ReportageNewsArticle" ||
        t === "BlogPosting" ||
        (Array.isArray(t) && t.some((x) => /Article|NewsArticle|BlogPosting/.test(x)));
      if (!isArticle) continue;
      const body = node.articleBody || node.text || node.description;
      if (typeof body === "string" && body.trim().length > 200) {
        // Pick the longest articleBody we find.
        if (!best || body.length > best.length) best = body.trim();
      }
    }
  }
  return best ? best.slice(0, ARTICLE_MAX_CHARS) : null;
}

// Pulls the page summary (og:description / twitter:description / meta
// description) as a 2-3 sentence body. Quality varies — but it's free,
// and present even on most paywalled articles.
function extractMetaDescription(html) {
  if (!html) return null;
  const patterns = [
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i,
    /<meta[^>]+name=["']twitter:description["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) {
      const t = decodeHtmlEntities(m[1]).replace(/\s+/g, " ").trim();
      if (t.length > 60) return t;
    }
  }
  return null;
}

// Tries common AMP URL patterns for the article. Many publishers serve a
// stripped, paywall-free AMP version at /amp/ or ?amp=1 because Google's
// mobile snippet expects it. Returns the article fetch result on first hit.
async function tryAmpVersion(originalUrl, requestId) {
  let u;
  try { u = new URL(originalUrl); } catch { return null; }

  const candidates = [];
  // /amp at end of path
  candidates.push(originalUrl.replace(/\/?$/, "/amp"));
  // /amp before trailing slash
  if (!u.pathname.endsWith("/amp")) {
    const path = u.pathname.replace(/\/$/, "");
    candidates.push(`${u.origin}${path}/amp${u.search}`);
  }
  // ?amp=1 query
  const sep = u.search ? "&" : "?";
  candidates.push(`${originalUrl}${sep}amp=1`);
  // outputType=amp (some CMSes)
  candidates.push(`${originalUrl}${sep}outputType=amp`);

  // Dedupe
  const tried = new Set();
  for (const candidate of candidates) {
    if (tried.has(candidate)) continue;
    tried.add(candidate);
    try {
      const article = await fetchArticleText(candidate, requestId);
      if (article.block) continue;
      if (article.text && article.text.length >= 300) {
        console.log(`[NoBait BG] requestId=${requestId} | AMP hit: ${candidate}`);
        return { article, ampUrl: candidate };
      }
    } catch (err) {
      // try next
    }
  }
  return null;
}

// Routes a fetch through 12ft.io's bypass proxy (which masquerades as
// Googlebot). Privacy: this sends the URL to 12ft.io. Off by default.
async function tryViaTwelveFt(originalUrl, requestId) {
  const proxyUrl = `https://12ft.io/${originalUrl}`;
  try {
    const article = await fetchArticleText(proxyUrl, requestId);
    if (article.block) return null;
    if (article.text && article.text.length >= 300) {
      return { article, proxyUrl };
    }
  } catch (err) {
    // give up
  }
  return null;
}

// Best-effort article date extraction. Tries URL date pattern first
// (e.g. /2026/04/25/), then common HTML metadata. Returns YYYY-MM-DD or null.
function extractArticleDate(url, html) {
  const urlMatch = (url || "").match(/\/(\d{4})\/(\d{1,2})\/(\d{1,2})\b/);
  if (urlMatch) {
    const y = urlMatch[1];
    const m = urlMatch[2].padStart(2, "0");
    const d = urlMatch[3].padStart(2, "0");
    if (y >= "2000" && y <= "2099") return `${y}-${m}-${d}`;
  }
  const patterns = [
    /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']article:published_time["']/i,
    /<meta[^>]+name=["']pubdate["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']publishdate["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']date["'][^>]+content=["'](\d{4}-\d{2}-\d{2}[^"']*)["']/i,
    /<time[^>]+datetime=["'](\d{4}-\d{2}-\d{2}[^"']*)["']/i,
  ];
  for (const re of patterns) {
    const m = (html || "").match(re);
    if (m && m[1]) {
      const iso = m[1].slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
    }
  }
  return null;
}

// ── Answer cache ─────────────────────────────────────────────────────
// Keyed by resolved URL. Entries expire after CACHE_TTL_MS so stale
// answers don't persist across sessions or after articles update.
const answerCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

// ── Strategy 2: Tab-based navigation (follows JS redirects) ─────────
// Opens the URL in a hidden background tab, lets the browser execute
// JavaScript, and captures the final URL after all redirects complete.
// Only reached when Strategy 1 finds no redirect — covers JS-only cases.

async function resolveViaTab(originalUrl, requestId) {
  return new Promise((resolve) => {
    let finalUrl = originalUrl;
    let resolved = false;
    let tabId = null;
    let settleTimer = null;

    const finish = () => {
      if (resolved) return;
      resolved = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      if (settleTimer) clearTimeout(settleTimer);
      if (tabId !== null) {
        chrome.tabs.remove(tabId).catch(() => {});
      }
      console.log(
        `[NoBait BG] requestId=${requestId} | Tab resolved: ${finalUrl}`
      );
      resolve(finalUrl);
    };

    const onUpdated = (id, changeInfo, tab) => {
      if (id !== tabId) return;

      // Track latest URL (skip blank/chrome pages)
      if (
        tab.url &&
        tab.url !== "about:blank" &&
        !tab.url.startsWith("chrome://") &&
        !tab.url.startsWith("chrome-error://")
      ) {
        finalUrl = tab.url;
      }

      // When a URL change is detected (JS navigation started)
      if (changeInfo.url && changeInfo.url !== originalUrl) {
        finalUrl = changeInfo.url;
        // Reset settle timer — wait for this new page to finish loading
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = null;
      }

      // When page finishes loading
      if (changeInfo.status === "complete") {
        if (settleTimer) clearTimeout(settleTimer);
        // Pick a settle delay:
        //   - URL already changed from original → quick (500ms)
        //   - Still on a known redirector host (Google News etc.) → long
        //     (5s) so the JS redirect has time to fire on slow first-hits
        //   - Anything else → standard 1.5s
        let delay;
        if (finalUrl !== originalUrl) {
          delay = 500;
        } else if (isRedirectorHost(finalUrl)) {
          delay = TAB_REDIRECTOR_SETTLE_MS;
          console.log(
            `[NoBait BG] requestId=${requestId} | Still on redirector host after complete — waiting ${delay}ms for JS redirect`
          );
        } else {
          delay = TAB_SETTLE_DELAY_MS;
        }
        settleTimer = setTimeout(finish, delay);
      }
    };

    const onRemoved = (id) => {
      if (id === tabId) finish();
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);

    chrome.tabs.create({ url: originalUrl, active: false }, (tab) => {
      if (chrome.runtime.lastError) {
        console.error(
          `[NoBait BG] requestId=${requestId} | Tab creation failed: ` +
            chrome.runtime.lastError.message
        );
        resolved = true;
        resolve(null);
        return;
      }
      tabId = tab.id;
      console.log(
        `[NoBait BG] requestId=${requestId} | Opened background tab ${tabId} for: ${originalUrl}`
      );
    });

    // Hard timeout
    setTimeout(finish, TAB_HARD_TIMEOUT_MS);
  });
}

// ── Main resolver pipeline ───────────────────────────────────────────

async function resolveUrl(originalUrl, requestId) {
  const startedAt = Date.now();
  console.log(
    `[NoBait BG] requestId=${requestId} | Starting resolution for: ${originalUrl}`
  );

  // ── Strategy 1: No-tab fetch resolver (fast, no background tab) ───────
  const noTabResult = await resolveViaNoTab(originalUrl, requestId);
  const noTabMs = Date.now() - startedAt;

  if (noTabResult && noTabResult.url !== originalUrl) {
    console.log(
      `[NoBait BG] requestId=${requestId} | No-tab resolver succeeded in ${noTabMs}ms\n` +
        `  original : ${originalUrl}\n` +
        `  resolved : ${noTabResult.url}\n` +
        `  method   : ${noTabResult.method}`
    );
    return {
      success: true,
      resolvedUrl: noTabResult.url,
      originalUrl,
      status: 200,
      redirected: true,
      method: noTabResult.method,
      resolveMs: noTabMs,
      noTabMs,
      tabMs: 0,
      requestId,
    };
  }

  // ── Strategy 2: Tab navigation (fallback for JS-only redirects) ───────
  console.log(
    `[NoBait BG] requestId=${requestId} | No-tab found no redirect after ${noTabMs}ms, trying tab navigation…`
  );

  const tabStartedAt = Date.now();
  const tabResult = await resolveViaTab(originalUrl, requestId);
  const tabMs = Date.now() - tabStartedAt;
  const totalMs = Date.now() - startedAt;

  if (tabResult && tabResult !== originalUrl) {
    console.log(
      `[NoBait BG] requestId=${requestId} | Tab navigation resolved in ${tabMs}ms (total ${totalMs}ms)\n` +
        `  original : ${originalUrl}\n` +
        `  resolved : ${tabResult}\n` +
        `  method   : tab-navigation`
    );
    return {
      success: true,
      resolvedUrl: tabResult,
      originalUrl,
      status: 200,
      redirected: true,
      method: "tab-navigation",
      resolveMs: totalMs,
      noTabMs,
      tabMs,
      requestId,
    };
  }

  // ── No redirect found ─────────────────────────────────────────────────
  console.log(
    `[NoBait BG] requestId=${requestId} | No redirect detected for: ${originalUrl}`
  );
  return {
    success: true,
    resolvedUrl: originalUrl,
    originalUrl,
    status: 200,
    redirected: false,
    method: "none",
    resolveMs: totalMs,
    noTabMs,
    tabMs,
    requestId,
  };
}

// ── Clickbait answer pipeline ────────────────────────────────────────
// After the URL is resolved we fetch the article, strip the HTML down
// to readable text, and ask the NoBait Worker for the briefest possible
// answer to the clickbait headline. Result is pushed to the content
// script via chrome.tabs.sendMessage so the tooltip updates in place.

// Fetches the resolved article URL and returns
// { html, text, fetchMs, httpStatus, htmlBytes, regionUsed, block, articleDate, articleTitle }.
// HTTP 4xx/5xx are not thrown — instead they're surfaced via `block` so the
// caller can show paywall/bot-block UI rather than a generic error. Network
// errors and timeouts are still thrown.
// `opts.withCookies` set to true sends `credentials: "include"` so logged-in
// publisher sessions return subscriber-tier HTML.
async function fetchArticleText(url, requestId, opts) {
  const withCookies = !!(opts && opts.withCookies);
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    ARTICLE_FETCH_TIMEOUT_MS
  );
  const startedAt = Date.now();

  try {
    const resp = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      credentials: withCookies ? "include" : "omit",
      headers: {
        "Accept": "text/html,application/xhtml+xml",
      },
    });
    clearTimeout(timeoutId);
    const fetchMs = Date.now() - startedAt;

    let html = "";
    try {
      html = await resp.text();
    } catch {
      html = "";
    }
    const { text, regionUsed } = extractReadableText(html);
    const block = detectBlock(url, resp.status, html, text);
    const articleDate = extractArticleDate(url, html);
    const articleTitle = extractArticleTitle(html);

    console.log(
      `[NoBait BG] requestId=${requestId} | Article fetch in ${fetchMs}ms | ` +
        `status=${resp.status}${withCookies ? " (cookied)" : ""} | text=${text.length}ch (region=${regionUsed}) | ` +
        `html=${html.length}B | title=${articleTitle ? `"${articleTitle.slice(0, 60)}"` : "n/a"} | ` +
        `date=${articleDate || "n/a"} | ` +
        `block=${block ? `${block.kind}: ${block.publisher || block.reason || block.detectedFrom}` : "none"}`
    );

    return {
      html,
      text,
      fetchMs,
      httpStatus: resp.status,
      htmlBytes: html.length,
      regionUsed,
      block,
      articleDate,
      articleTitle,
    };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.fetchMs === undefined) err.fetchMs = Date.now() - startedAt;
    const aborted = err && err.name === "AbortError";
    console.warn(
      `[NoBait BG] requestId=${requestId} | Article fetch failed after ${err.fetchMs}ms: ${
        aborted ? "timeout" : err.message
      }`
    );
    throw err;
  }
}

// Pulls readable text out of raw HTML. Drops script/style/noscript/svg,
// picks <article>/<main>/<body> in that order, strips remaining tags,
// decodes common entities, and truncates to ARTICLE_MAX_CHARS.
// Returns { text, regionUsed } so the debug log can show which region won.
function extractReadableText(html) {
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ");

  const articleMatch = cleaned.match(/<article[\s\S]*?<\/article>/i);
  const mainMatch = cleaned.match(/<main[\s\S]*?<\/main>/i);
  const bodyMatch = cleaned.match(/<body[\s\S]*?<\/body>/i);
  let region, regionUsed;
  if (articleMatch) {
    region = articleMatch[0];
    regionUsed = "article";
  } else if (mainMatch) {
    region = mainMatch[0];
    regionUsed = "main";
  } else if (bodyMatch) {
    region = bodyMatch[0];
    regionUsed = "body";
  } else {
    region = cleaned;
    regionUsed = "raw";
  }

  const text = region
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();

  return { text: text.slice(0, ARTICLE_MAX_CHARS), regionUsed };
}

// Standard prompt — short summary with context, 1-2 sentences. Rules below
// address common failure modes:
// - Cryptic one-word answers ("Raspberry Pi") that don't explain themselves
// - Lists collapsed to a single item or two
// - Bare names returned for headlines that aren't asking "who"
// - Declarative (non-clickbait) headlines getting non-answers
function buildStandardPrompt(headline, articleText) {
  return (
    `You strip clickbait from headlines. Read the headline and article excerpt ` +
    `below, then write the briefest answer that actually satisfies what the ` +
    `headline promises. The user should not need to click through to understand.\n\n` +
    `STYLE\n` +
    `- Hard limit: ${ANSWER_MAX_CHARS} characters. Aim shorter when you can.\n` +
    `- No prefixes ("Answer:", "TL;DR:"), no surrounding quotes, no markdown.\n` +
    `- No trailing period unless the answer is a full sentence.\n\n` +
    `CONTENT RULES\n` +
    `1. If the headline poses a question, answer it with substance, not just a topic word.\n` +
    `   Bad:  "Raspberry Pi"\n` +
    `   Good: "Sony locks TV apps behind required account; use a Raspberry Pi as a workaround."\n` +
    `   Bad:  "ChatGPT, Gemini, Claude"\n` +
    `   Good: "All three invented fake finishers and described impossible body mechanics with confidence."\n\n` +
    `2. If the headline implies a list ("5 features…", "three reasons…", "what changes could X make"),\n` +
    `   enumerate UP TO FIVE items in the order they appear in the article, separated by semicolons.\n` +
    `   Bad:  "Ad-free playback, screen off"\n` +
    `   Good: "Ad-free playback; background play with screen off; offline downloads; smart downloads; personalized mixes"\n\n` +
    `3. Only return a bare name when the headline explicitly asks "who" or implies a single person/thing did one thing.\n` +
    `   "Who scored the winning goal?" → "Mbappé" is fine.\n` +
    `   "What changes could the Phillies make?" → NEVER just a manager's name. Enumerate the changes.\n\n` +
    `4. If the headline is declarative (not really clickbait), answer the implicit follow-up a curious reader has —\n` +
    `   the specific who / what / why / how much.\n` +
    `   Headline: "Trump bought $51M in stocks, filing shows" → "Tech-heavy: Apple, Nvidia, Microsoft, Meta — purchased Mar 1–14"\n` +
    `   Headline: "Marketing collective explores $1bn stake sale" → "Selling minority stake; CVC and KKR among interested PE buyers"\n\n` +
    `Headline: ${headline || "(unknown)"}\n\n` +
    `Article excerpt:\n${articleText}`
  );
}

// Punchline prompt — bare distilled answer in fragments, no sentences,
// no fluff. Output examples are the user's own desired format.
function buildPunchlinePrompt(headline, articleText) {
  return (
    `You strip clickbait to its bare PUNCHLINE. Read the headline and article ` +
    `excerpt and answer in AS FEW WORDS AS POSSIBLE — the distilled payoff only.\n\n` +
    `OUTPUT RULES (STRICT)\n` +
    `- Fragments only. NO complete sentences. No subject + verb constructions.\n` +
    `- No filler: skip "the", "a", "an", "this", "is", "are", "you", "your".\n` +
    `- Hard limit: ${PUNCHLINE_MAX_CHARS} characters. Aim under 50.\n` +
    `- No prefixes ("Answer:", "TL;DR:"), no quotes, no markdown.\n\n` +
    `PATTERNS BY HEADLINE TYPE (USE THE EXACT FORMAT)\n\n` +
    `[Single thing / answer] → just that noun phrase, no period, no article.\n` +
    `  Headline: "Costco just rolled out a new snack but only for a limited time"\n` +
    `  → Caramel Churro Sundae\n\n` +
    `  Headline: "Who scored the winning goal?"\n` +
    `  → Mbappé\n\n` +
    `[Action / method / hack] → noun phrase naming the trick, period optional.\n` +
    `  Headline: "I finally stopped fighting with spotty hotel Wi-Fi thanks to this Netflix USB hack"\n` +
    `  → USB-C to ethernet adapter.\n\n` +
    `[List of N things] → numbered inline "1. X 2. Y 3. Z" (cap at 5).\n` +
    `  Headline: "I asked ChatGPT for unconventional productivity hacks — these are the 3 that actually worked"\n` +
    `  → 1. Reverse to-do list 2. Chaos sprints 3. Task gamification\n\n` +
    `  Headline: "5 budget tips that saved me $2,000"\n` +
    `  → 1. Cancel subscriptions 2. Meal-prep 3. Used clothes 4. Brand swaps 5. Cash-back card\n\n` +
    `[Question with multi-cause answer] → comma-separated key causes, no "because".\n` +
    `  Headline: "Why are Treasury yields rising?"\n` +
    `  → Strong jobs data, sticky inflation, fewer Fed cuts\n\n` +
    `[Declarative news headline] → just the salient fact.\n` +
    `  Headline: "Trump bought $51M in stocks, filing shows"\n` +
    `  → Apple, Nvidia, Microsoft, Meta\n\n` +
    `Headline: ${headline || "(unknown)"}\n\n` +
    `Article excerpt:\n${articleText}`
  );
}

// Dispatches to the right prompt builder based on summary style. `style`
// is "standard" (default) or "punchline".
function buildPrompt(headline, articleText, style) {
  return style === "punchline"
    ? buildPunchlinePrompt(headline, articleText)
    : buildStandardPrompt(headline, articleText);
}

// POSTs the prompt to the shared NoBait Worker and returns
// { answer, rawAnswer, workerStatus, aiCallMs, promptChars, style }.
// `style` is "standard" (default) or "punchline" — drives both the prompt
// and the post-processing trim cap.
async function askWorkerForAnswer(headline, articleText, requestId, style) {
  const useStyle = style === "punchline" ? "punchline" : "standard";
  const prompt = buildPrompt(headline, articleText, useStyle);
  const cap = useStyle === "punchline" ? PUNCHLINE_MAX_CHARS : ANSWER_MAX_CHARS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const resp = await fetch(NOBAIT_WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: prompt }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const aiCallMs = Date.now() - startedAt;

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const detail =
        (data && (data.detail || data.error)) || `HTTP ${resp.status}`;
      const err = new Error(`Worker error: ${detail}`);
      err.workerStatus = resp.status;
      err.aiCallMs = aiCallMs;
      throw err;
    }
    const raw = String((data && data.summary) || "").trim();
    if (!raw) {
      const err = new Error("Empty answer from worker");
      err.workerStatus = resp.status;
      err.aiCallMs = aiCallMs;
      throw err;
    }
    // Punchline mode trims to a clean fragment boundary (last word break)
    // rather than appending an ellipsis — fragments shouldn't have "…" appended.
    const answer = useStyle === "punchline"
      ? trimPunchline(raw, cap)
      : trimAnswer(raw, cap);
    console.log(
      `[NoBait BG] requestId=${requestId} | Worker answer (${useStyle}) in ${aiCallMs}ms (${answer.length}ch): ${answer}`
    );
    return { answer, rawAnswer: raw, workerStatus: resp.status, aiCallMs, promptChars: prompt.length, style: useStyle };
  } catch (err) {
    clearTimeout(timeoutId);
    const aborted = err && err.name === "AbortError";
    if (aborted && err.aiCallMs === undefined) err.aiCallMs = Date.now() - startedAt;
    console.warn(
      `[NoBait BG] requestId=${requestId} | Worker call failed after ${err.aiCallMs || "?"}ms: ${
        aborted ? "timeout" : err.message
      }`
    );
    throw err;
  }
}

// Normalizes model output: strips wrapping quotes, collapses whitespace,
// hard-caps length with a trailing ellipsis if cut.
function trimAnswer(text, cap) {
  const limit = cap || ANSWER_MAX_CHARS;
  let t = text.replace(/\s+/g, " ").trim();
  t = t.replace(/^["'`""'']+|["'`""'']+$/g, "").trim();
  if (t.length > limit) {
    t = t.slice(0, limit - 1).trimEnd() + "…";
  }
  return t;
}

// Trim for Punchline style. Punchlines are fragments — no ellipsis,
// no mid-word cut. If we have to trim, trim to the last word break.
function trimPunchline(text, cap) {
  const limit = cap || PUNCHLINE_MAX_CHARS;
  let t = text.replace(/\s+/g, " ").trim();
  t = t.replace(/^["'`""'']+|["'`""'']+$/g, "").trim();
  // Strip common AI prefixes the punchline prompt forbids but the model
  // sometimes still adds when the answer is very short.
  t = t.replace(/^(answer|tl;dr|punchline|response)\s*[:\-—]\s*/i, "");
  if (t.length > limit) {
    const slice = t.slice(0, limit);
    const lastSpace = slice.lastIndexOf(" ");
    t = lastSpace > limit * 0.5 ? slice.slice(0, lastSpace) : slice;
    t = t.replace(/[,;:.!?\-—–]+$/, "").trim();
  }
  return t;
}

// Like trimAnswer but trims to a complete sentence boundary when possible.
// Used for the expanded "More context" answer where mid-word "…" looks
// terrible. Falls back to hard truncation only if no decent sentence break
// is reachable; never appends an ellipsis.
function trimToCompleteSentence(text, maxChars) {
  let t = text.replace(/\s+/g, " ").trim();
  t = t.replace(/^["'`""'']+|["'`""'']+$/g, "").trim();
  if (t.length <= maxChars) return t;

  const slice = t.slice(0, maxChars);
  // Find the last sentence-ending punctuation in the slice (preferring later
  // ones). Acceptable terminators: . ! ?  followed by space, end, or quote.
  const re = /[.!?](?=\s|["')\]]?$|["')\]]\s)/g;
  let lastEnd = -1;
  let m;
  while ((m = re.exec(slice)) !== null) lastEnd = m.index;

  if (lastEnd >= maxChars * 0.6) {
    return slice.slice(0, lastEnd + 1).trim();
  }
  // No good sentence break in the back portion — hard-trim, no ellipsis.
  return slice.trimEnd();
}

// Walks the user-enabled fallback chain in order. Each step either returns
// a usable summary or null; the first non-null wins. Progress messages
// stream to the tooltip as each step starts so the user sees what's running.
//
// Returns { answer, rawAnswer, method, articleText?, source: {name, publisher, url, snapshotDate}? }
// or null if every enabled step failed.
// Runs a single fallback method on demand (user clicked the corresponding
// button in the tooltip). Returns { found, answer, source?, error? }.
// Re-uses the answer cache for the article HTML/text so jsonLd/metaDesc
// don't need a refetch.
async function runManualFallback(method, ctx) {
  const { headline, originalUrl, resolvedUrl, requestId, tabId } = ctx;
  // Load style from settings so the manual button matches the user's choice.
  const settings = await getSettings();
  const style = settings.summaryStyle || DEFAULT_STYLE;

  sendDebugEvent(tabId, requestId, "INFO",
    `Manual fallback "${method}" requested | style=${style} | resolvedUrl=${resolvedUrl} | headline="${headline.slice(0, 60)}"`
  );

  const cached = answerCache.get(resolvedUrl);
  let articleHtml = null;
  let articleText = null;
  if (cached) {
    articleText = cached.articleText || null;
    // We don't cache HTML — would be too big. For jsonLd/metaDesc on a
    // cached entry, refetch (cheap).
  }

  const fetchFresh = async (withCookies) => {
    sendDebugEvent(tabId, requestId, "INFO",
      `Manual ${method}: fetching ${withCookies ? "with cookies" : "fresh"}…`
    );
    const a = await fetchArticleText(resolvedUrl, requestId, { withCookies });
    return a;
  };

  if (method === "jsonLd" || method === "metaDesc") {
    // These need HTML — refetch (cheap) then extract.
    let article;
    try { article = await fetchFresh(false); }
    catch (err) {
      return { found: false, error: `Couldn't refetch article: ${err.message}` };
    }
    articleHtml = article.html;
    let body;
    if (method === "jsonLd") {
      body = extractJsonLdBody(articleHtml);
      sendDebugEvent(tabId, requestId, "INFO", `JSON-LD extraction: ${body ? body.length + " chars found" : "no articleBody"}`);
    } else {
      body = extractMetaDescription(articleHtml);
      sendDebugEvent(tabId, requestId, "INFO", `Meta description extraction: ${body ? body.length + " chars found" : "none"}`);
    }
    if (!body || body.length < 60) {
      return { found: false, error: `${method === "jsonLd" ? "No JSON-LD article body" : "No meta description"} on this page.` };
    }
    const r = await askWorkerForAnswer(headline, body, requestId, style);
    sendDebugEvent(tabId, requestId, "INFO", `Manual ${method} summary OK (${style}): ${r.answer.length} chars`);
    return { found: true, answer: r.answer, rawAnswer: r.rawAnswer };
  }

  if (method === "cookies") {
    let article;
    try { article = await fetchFresh(true); }
    catch (err) {
      return { found: false, error: `Cookied refetch failed: ${err.message}` };
    }
    if (article.block) {
      sendDebugEvent(tabId, requestId, "WARN", `Cookied refetch still blocked: ${article.block.kind}`);
      return { found: false, error: `Still blocked even with cookies (${article.block.kind}). Are you logged in to ${(function () { try { return new URL(resolvedUrl).hostname; } catch { return "this site"; } })()}?` };
    }
    if (!article.text || article.text.length < 200) {
      return { found: false, error: `Cookied refetch returned only ${article.text.length} chars.` };
    }
    const r = await askWorkerForAnswer(headline, article.text, requestId, style);
    sendDebugEvent(tabId, requestId, "INFO", `Manual cookies summary OK (${style}): ${r.answer.length} chars`);
    return { found: true, answer: r.answer, rawAnswer: r.rawAnswer };
  }

  if (method === "amp") {
    const amp = await tryAmpVersion(originalUrl, requestId);
    if (!amp || !amp.article.text || amp.article.text.length < 200) {
      sendDebugEvent(tabId, requestId, "WARN", `AMP version: not found or too short`);
      return { found: false, error: "No usable AMP version found at the common URL patterns." };
    }
    sendDebugEvent(tabId, requestId, "INFO", `AMP version found: ${amp.ampUrl} (${amp.article.text.length} chars)`);
    const r = await askWorkerForAnswer(headline, amp.article.text, requestId, style);
    return {
      found: true, answer: r.answer, rawAnswer: r.rawAnswer,
      source: { name: "AMP version", url: amp.ampUrl },
    };
  }

  if (method === "twelveFt") {
    const proxy = await tryViaTwelveFt(originalUrl, requestId);
    if (!proxy || !proxy.article.text || proxy.article.text.length < 200) {
      sendDebugEvent(tabId, requestId, "WARN", `12ft.io proxy: not usable`);
      return { found: false, error: "12ft.io proxy didn't return usable content." };
    }
    sendDebugEvent(tabId, requestId, "INFO", `12ft.io OK: ${proxy.article.text.length} chars`);
    const r = await askWorkerForAnswer(headline, proxy.article.text, requestId, style);
    return {
      found: true, answer: r.answer, rawAnswer: r.rawAnswer,
      source: { name: "12ft.io", url: proxy.proxyUrl },
    };
  }

  return { found: false, error: `Unknown manual fallback method: ${method}` };
}

async function runFallbackChain(article, originalUrl, headline, articleDate, requestId, tabId, settings) {
  const fb = settings.fallbacks;
  const style = settings.summaryStyle || DEFAULT_STYLE;
  // Helper: each fallback is { enabled, auto } now. Auto-fallback chain only
  // runs steps where auto === true.
  const isAuto = (key) => !!(fb[key] && fb[key].auto);

  // Free + instant — re-extract from the HTML we already fetched.
  if (isAuto("jsonLd") && article && article.html) {
    sendProgress(tabId, requestId, "Trying embedded article body…");
    const body = extractJsonLdBody(article.html);
    if (body && body.length >= 200) {
      try {
        const r = await askWorkerForAnswer(headline, body, requestId, style);
        return { answer: r.answer, rawAnswer: r.rawAnswer, method: "jsonLd", articleText: body };
      } catch (e) { /* fall through */ }
    }
  }

  if (isAuto("metaDesc") && article && article.html) {
    sendProgress(tabId, requestId, "Trying page summary metadata…");
    const desc = extractMetaDescription(article.html);
    if (desc && desc.length >= 100) {
      try {
        const r = await askWorkerForAnswer(headline, desc, requestId, style);
        return { answer: r.answer, rawAnswer: r.rawAnswer, method: "metaDesc", articleText: desc };
      } catch (e) { /* fall through */ }
    }
  }

  if (isAuto("cookies")) {
    sendProgress(tabId, requestId, "Retrying with your browser cookies…");
    try {
      const cookied = await fetchArticleText(originalUrl, requestId, { withCookies: true });
      if (!cookied.block && cookied.text && cookied.text.length >= 200) {
        const r = await askWorkerForAnswer(headline, cookied.text, requestId, style);
        return { answer: r.answer, rawAnswer: r.rawAnswer, method: "cookies", articleText: cookied.text };
      }
    } catch (e) { /* fall through */ }
  }

  if (isAuto("amp")) {
    sendProgress(tabId, requestId, "Trying AMP version…");
    try {
      const amp = await tryAmpVersion(originalUrl, requestId);
      if (amp && amp.article.text && amp.article.text.length >= 200) {
        const r = await askWorkerForAnswer(headline, amp.article.text, requestId, style);
        return {
          answer: r.answer, rawAnswer: r.rawAnswer, method: "amp",
          articleText: amp.article.text,
          source: { name: "AMP version", url: amp.ampUrl },
        };
      }
    } catch (e) { /* fall through */ }
  }

  if (isAuto("twelveFt")) {
    sendProgress(tabId, requestId, "Trying 12ft.io proxy…");
    try {
      const proxy = await tryViaTwelveFt(originalUrl, requestId);
      if (proxy && proxy.article.text && proxy.article.text.length >= 200) {
        const r = await askWorkerForAnswer(headline, proxy.article.text, requestId, style);
        return {
          answer: r.answer, rawAnswer: r.rawAnswer, method: "twelveFt",
          articleText: proxy.article.text,
          source: { name: "12ft.io", url: proxy.proxyUrl },
        };
      }
    } catch (e) { /* fall through */ }
  }

  if (isAuto("altSource")) {
    sendProgress(tabId, requestId, "Searching alternative publishers…");
    try {
      const alt = await findAlternativeSource(headline, originalUrl, articleDate, requestId, tabId, style);
      if (alt && alt.found && alt.answer) {
        return {
          answer: alt.answer, rawAnswer: alt.rawAnswer, method: "altSource",
          source: {
            name: alt.source,
            publisher: alt.publisher,
            url: alt.articleUrl,
            attempts: alt.attempts,
          },
        };
      }
    } catch (e) { /* fall through */ }
  }

  if (isAuto("archive")) {
    sendProgress(tabId, requestId, "Looking up Wayback Machine snapshot…");
    try {
      const arch = await tryArchiveSummary(originalUrl, headline, requestId, tabId, style);
      if (arch && arch.found && arch.answer) {
        return {
          answer: arch.answer, rawAnswer: arch.rawAnswer, method: "archive",
          source: {
            name: "Wayback Machine",
            url: arch.archiveUrl,
            snapshotDate: arch.snapshotDate,
          },
        };
      }
    } catch (e) { /* fall through */ }
  }

  return null;
}

// Runs after URL resolution: fetches the resolved article, asks the
// Worker for a clickbait answer, and messages the result back to the
// tab so the tooltip can swap its "Reading the article" placeholder.
// If the primary attempt fails (block detected, text too short, AI error),
// runs the user-enabled fallback chain with real-time progress messages.
async function pushClickbaitAnswer(tabId, requestId, linkText, originalUrl, resolvedUrl) {
  const pipelineStartedAt = Date.now();
  const baseMeta = {
    promptVersion: PROMPT_VERSION,
    detectedHeadline: linkText || "",
    headlineLength: (linkText || "").length,
    cacheHit: false,
    articleLength: null,
    articleHtmlBytes: null,
    articleRegionUsed: null,
    articleFetchMs: null,
    articleHttpStatus: null,
    articleDate: null,
    articleTitle: null,
    blockKind: null,
    blockReason: null,
    fallbackMethod: null,
    aiCallMs: null,
    workerStatus: null,
    rawAnswer: null,
    promptChars: null,
    answerChars: null,
    pipelineMs: null,
    promptMaxChars: ANSWER_MAX_CHARS,
    articleMaxChars: ARTICLE_MAX_CHARS,
  };

  // Cache hit — same as before, return immediately.
  const cached = answerCache.get(resolvedUrl);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    console.log(`[NoBait BG] requestId=${requestId} | Cache hit for: ${resolvedUrl}`);
    const meta = {
      ...baseMeta,
      ...(cached.meta || {}),
      cacheHit: true,
      pipelineMs: Date.now() - pipelineStartedAt,
      answerChars: cached.answer.length,
    };
    chrome.tabs
      .sendMessage(tabId, {
        type: "clickbait-answer",
        requestId,
        answer: cached.answer,
        resolvedUrl,
        source: cached.source || null,
        meta,
      })
      .catch(() => {});
    return;
  }

  // Load user settings once for the whole pipeline.
  const settings = await getSettings();

  // Primary fetch.
  let article;
  try {
    sendProgress(tabId, requestId, "Reading the article");
    article = await fetchArticleText(resolvedUrl, requestId);
  } catch (err) {
    baseMeta.pipelineMs = Date.now() - pipelineStartedAt;
    chrome.tabs
      .sendMessage(tabId, {
        type: "clickbait-answer",
        requestId,
        error: `Couldn't fetch article: ${err.message}`,
        meta: baseMeta,
      })
      .catch(() => {});
    return;
  }

  baseMeta.articleLength = article.text.length;
  baseMeta.articleHtmlBytes = article.htmlBytes;
  baseMeta.articleRegionUsed = article.regionUsed;
  baseMeta.articleFetchMs = article.fetchMs;
  baseMeta.articleHttpStatus = article.httpStatus;
  baseMeta.articleDate = article.articleDate;
  baseMeta.articleTitle = article.articleTitle;

  // Effective block check: real block detected OR we ended up still on a
  // redirector host (Google News etc.) which means the redirect didn't fire.
  let effectiveBlock = article.block;
  if (!effectiveBlock && isRedirectorHost(resolvedUrl)) {
    effectiveBlock = {
      kind: "redirect-failed",
      publisher: (function () {
        try { return new URL(resolvedUrl).hostname; } catch { return "redirector"; }
      })(),
      reason: "Tab navigation didn't catch the JS redirect to the publisher",
    };
  }
  if (effectiveBlock) {
    baseMeta.blockKind = effectiveBlock.kind;
    baseMeta.blockReason =
      effectiveBlock.reason || effectiveBlock.publisher || effectiveBlock.detectedFrom || "unknown";
  }

  // Try the primary summarize ONLY if no block AND body is non-empty.
  // Short bodies are passed as-is — the model will produce what it can.
  // Style comes from popup settings (Standard vs Punchline).
  const style = settings.summaryStyle || DEFAULT_STYLE;
  baseMeta.summaryStyle = style;
  let primarySummary = null;
  if (!effectiveBlock && article.text && article.text.length > 0) {
    sendDebugEvent(tabId, requestId, "INFO", `Attempting summarize: body is ${article.text.length} chars`);
    try {
      const r = await askWorkerForAnswer(linkText, article.text, requestId, style);
      primarySummary = r;
      baseMeta.aiCallMs = r.aiCallMs;
      baseMeta.workerStatus = r.workerStatus;
      baseMeta.rawAnswer = r.rawAnswer;
      baseMeta.promptChars = r.promptChars;
      baseMeta.answerChars = r.answer.length;
    } catch (e) {
      console.warn(`[NoBait BG] requestId=${requestId} | Primary AI call failed: ${e.message} — running fallbacks`);
    }
  }

  if (primarySummary) {
    baseMeta.pipelineMs = Date.now() - pipelineStartedAt;
    answerCache.set(resolvedUrl, {
      answer: primarySummary.answer,
      timestamp: Date.now(),
      meta: { ...baseMeta },
      articleText: article.text,
      headline: linkText || article.articleTitle || "",
    });
    chrome.tabs
      .sendMessage(tabId, {
        type: "clickbait-answer",
        requestId,
        answer: primarySummary.answer,
        resolvedUrl,
        meta: baseMeta,
      })
      .catch(() => {});
    return;
  }

  // Primary failed. Run fallback chain (only enabled steps, in the
  // jsonLd → metaDesc → cookies → amp → twelveFt → altSource → archive order).
  const fallback = await runFallbackChain(
    article,
    originalUrl,
    linkText,
    article.articleDate,
    requestId,
    tabId,
    settings
  );

  if (fallback) {
    baseMeta.fallbackMethod = fallback.method;
    baseMeta.rawAnswer = fallback.rawAnswer;
    baseMeta.answerChars = fallback.answer.length;
    baseMeta.pipelineMs = Date.now() - pipelineStartedAt;
    console.log(
      `[NoBait BG] requestId=${requestId} | Fallback succeeded via "${fallback.method}" in ${baseMeta.pipelineMs}ms`
    );

    answerCache.set(resolvedUrl, {
      answer: fallback.answer,
      timestamp: Date.now(),
      meta: { ...baseMeta },
      articleText: fallback.articleText || article.text || "",
      headline: linkText || article.articleTitle || "",
      source: fallback.source || null,
    });

    chrome.tabs
      .sendMessage(tabId, {
        type: "clickbait-answer",
        requestId,
        answer: fallback.answer,
        resolvedUrl,
        source: fallback.source || { method: fallback.method },
        fallbackMethod: fallback.method,
        meta: baseMeta,
      })
      .catch(() => {});
    return;
  }

  // No fallback worked. If we hit a block originally, surface the block UI;
  // otherwise show a generic "couldn't summarize" error.
  baseMeta.pipelineMs = Date.now() - pipelineStartedAt;
  if (effectiveBlock) {
    chrome.tabs
      .sendMessage(tabId, {
        type: "clickbait-blocked",
        requestId,
        block: effectiveBlock,
        headline: linkText,
        articleTitle: article.articleTitle,
        originalUrl,
        resolvedUrl,
        articleDate: article.articleDate,
        meta: baseMeta,
      })
      .catch(() => {});
  } else {
    chrome.tabs
      .sendMessage(tabId, {
        type: "clickbait-answer",
        requestId,
        error: `Couldn't summarize (${article.text.length}-char body, no fallback succeeded)`,
        meta: baseMeta,
      })
      .catch(() => {});
  }
}

// ── Block alternatives: archive, search, best-guess ──────────────────

// Looks the URL up in the Wayback Machine. If a snapshot exists, fetches
// the raw page (id_ modifier strips the Wayback wrapper) and runs it
// through the same clickbait-answer pipeline. Returns:
//   { found: true, source, archiveUrl, snapshotDate, answer, rawAnswer, meta }
//   { found: false, archiveUrlGuess, reason }
async function tryArchiveSummary(originalUrl, headline, requestId, tabId, style) {
  const useStyle = style || DEFAULT_STYLE;
  sendDebugEvent(tabId, requestId, "INFO", `Archive lookup starting (style=${useStyle}) for: ${originalUrl}`);
  const startedAt = Date.now();

  // Wayback availability API — JSON, very fast
  const availController = new AbortController();
  const availTimeout = setTimeout(() => availController.abort(), ARCHIVE_AVAIL_TIMEOUT_MS);
  let closest = null;
  try {
    const availResp = await fetch(
      `https://archive.org/wayback/available?url=${encodeURIComponent(originalUrl)}`,
      { signal: availController.signal }
    );
    clearTimeout(availTimeout);
    const availData = await availResp.json().catch(() => ({}));
    closest = availData && availData.archived_snapshots && availData.archived_snapshots.closest;
    sendDebugEvent(tabId, requestId, "INFO",
      `Wayback availability check: ${closest ? `snapshot found (${closest.timestamp})` : "no snapshot"}`
    );
  } catch (err) {
    clearTimeout(availTimeout);
    sendDebugEvent(tabId, requestId, "WARN", `Wayback availability check failed: ${err.message}`);
  }

  if (!closest || !closest.url) {
    return {
      found: false,
      reason: "No Wayback snapshot found",
      archiveUrlGuess: `https://web.archive.org/web/2*/${originalUrl}`,
      archivePhUrl: `https://archive.ph/newest/${encodeURIComponent(originalUrl)}`,
      lookupMs: Date.now() - startedAt,
    };
  }

  // Use id_ modifier to fetch the snapshot without the Wayback toolbar wrapper.
  // Format: https://web.archive.org/web/<ts>id_/<original>
  const rawSnapshotUrl = closest.url.replace(/(\d{14})\//, "$1id_/");
  const snapshotDate = closest.timestamp
    ? `${closest.timestamp.slice(0, 4)}-${closest.timestamp.slice(4, 6)}-${closest.timestamp.slice(6, 8)}`
    : "unknown";

  sendDebugEvent(tabId, requestId, "INFO",
    `Wayback snapshot found from ${snapshotDate} | fetching ${rawSnapshotUrl.slice(0, 100)}`
  );

  let article;
  try {
    article = await fetchArticleText(rawSnapshotUrl, requestId);
    sendDebugEvent(tabId, requestId, "INFO",
      `Wayback snapshot fetched: ${article.text.length} chars (status ${article.httpStatus})`
    );
  } catch (err) {
    sendDebugEvent(tabId, requestId, "WARN", `Wayback snapshot fetch failed: ${err.message}`);
    return {
      found: true,
      source: "wayback",
      archiveUrl: closest.url,
      snapshotDate,
      answer: null,
      error: `Found Wayback snapshot but fetch failed: ${err.message}`,
      lookupMs: Date.now() - startedAt,
    };
  }

  if (article.block || !article.text || article.text.length < 100) {
    sendDebugEvent(tabId, requestId, "WARN",
      `Wayback snapshot unusable: ${article.block ? `blocked (${article.block.kind})` : `text=${article.text.length} chars`}`
    );
    return {
      found: true,
      source: "wayback",
      archiveUrl: closest.url,
      snapshotDate,
      answer: null,
      error: article.block
        ? `Snapshot also blocked: ${article.block.kind}`
        : `Snapshot text too short (${article.text.length} chars)`,
      lookupMs: Date.now() - startedAt,
    };
  }

  let answerResult;
  try {
    answerResult = await askWorkerForAnswer(headline, article.text, requestId, useStyle);
    sendDebugEvent(tabId, requestId, "INFO",
      `Wayback summary OK (${useStyle}): ${answerResult.answer.length} chars in ${answerResult.aiCallMs}ms`
    );
  } catch (err) {
    sendDebugEvent(tabId, requestId, "WARN", `Wayback AI summary failed: ${err.message}`);
    return {
      found: true,
      source: "wayback",
      archiveUrl: closest.url,
      snapshotDate,
      answer: null,
      error: `Snapshot fetched but AI call failed: ${err.message}`,
      lookupMs: Date.now() - startedAt,
    };
  }

  return {
    found: true,
    source: "wayback",
    archiveUrl: closest.url,
    snapshotDate,
    answer: answerResult.answer,
    rawAnswer: answerResult.rawAnswer,
    meta: {
      articleLength: article.text.length,
      articleFetchMs: article.fetchMs,
      aiCallMs: answerResult.aiCallMs,
      promptChars: answerResult.promptChars,
      lookupMs: Date.now() - startedAt,
    },
  };
}

// Asks the Worker for a topic-context answer based on the headline + date.
// IMPORTANT: this is NOT "guess what THIS specific article says" — that
// produces wishy-washy hedges like "the article likely discusses market
// trends". Instead, treat the headline as a question the user is asking
// you, and answer the topic directly using your knowledge of similar
// coverage from around the article's date.
// Returns { answer, rawAnswer, aiCallMs, promptChars, workerStatus }.
async function bestGuessSummary(headline, originalUrl, resolvedUrl, articleDate, requestId, tabId) {
  let publisher = "unknown";
  try {
    publisher = new URL(resolvedUrl || originalUrl).hostname.replace(/^www\./, "");
  } catch {}
  sendDebugEvent(tabId, requestId, "INFO",
    `Best-guess starting | publisher=${publisher} | date=${articleDate || "n/a"} | headline="${(headline || "").slice(0, 80)}"`
  );

  const dateLine = articleDate
    ? `Article publish date: ${articleDate}`
    : `Article publish date: unknown (treat as very recent)`;

  const prompt =
    `The user wanted to read an article they can't access (paywalled, blocked, or ` +
    `the redirect failed). Treat the headline as a question they're asking you, and ` +
    `answer the topic directly — like a normal ChatGPT-style answer about the subject.\n\n` +
    `DO NOT do any of these:\n` +
    `- Don't say "the article likely discusses X" or "this might cover Y".\n` +
    `- Don't try to reconstruct the specific article — you haven't read it.\n` +
    `- Don't hedge about not having access to the source.\n\n` +
    `DO this:\n` +
    `- Answer the substantive question or topic the headline raises.\n` +
    `- Draw on similar coverage and general knowledge from around the article's date.\n` +
    `- Be specific: numbers, names, mechanisms, context, what was happening at that time.\n` +
    `- If your training knowledge ends before the date, say so once and offer the closest ` +
    `   relevant context you do have.\n` +
    `- If you're drawing heavily on a specific publication's coverage of the topic, end with ` +
    `   "(via <publication>)". Otherwise no citation needed.\n` +
    `- Soft limit ~${BEST_GUESS_MAX_CHARS} characters. Always end on a COMPLETE SENTENCE — ` +
    `your last character must be . ! or ?. Never truncate mid-word or mid-thought. Plain text.\n\n` +
    `EXAMPLES\n` +
    `Headline: "Price of access to Trump's memecoin VIP reception plunges"\n` +
    `→ "The TRUMP token's VIP-reception event saw entry-cost requirements drop sharply ` +
    `   as token price fell from peak. Originally pitched as a top-220-holder dinner, ` +
    `   the implied price-per-seat collapsed alongside broader meme-coin selloff in spring 2026."\n\n` +
    `Headline: "Why are Treasury yields rising?"\n` +
    `→ "Yields rose on stronger-than-expected jobs data, sticky core inflation, and Fed ` +
    `   commentary signaling fewer 2026 cuts. 10-year crossed 4.7% mid-quarter; demand at ` +
    `   recent auctions has been weaker amid foreign-buyer pullback."\n\n` +
    `INPUT\n` +
    `Headline: ${headline || "(unknown — try to infer from URL)"}\n` +
    `URL: ${resolvedUrl || originalUrl}\n` +
    `Publisher: ${publisher}\n` +
    dateLine;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const resp = await fetch(NOBAIT_WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: prompt }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const aiCallMs = Date.now() - startedAt;
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const detail = (data && (data.detail || data.error)) || `HTTP ${resp.status}`;
      throw new Error(`Worker error: ${detail}`);
    }
    const raw = String((data && data.summary) || "").trim();
    if (!raw) throw new Error("Empty answer from worker");
    const answer = trimToCompleteSentence(raw, BEST_GUESS_MAX_CHARS);
    sendDebugEvent(tabId, requestId, "INFO",
      `Best-guess answer in ${aiCallMs}ms (${answer.length}ch): "${answer.slice(0, 100)}"`
    );
    return {
      answer,
      rawAnswer: raw,
      aiCallMs,
      promptChars: prompt.length,
      workerStatus: resp.status,
    };
  } catch (err) {
    clearTimeout(timeoutId);
    const aborted = err && err.name === "AbortError";
    sendDebugEvent(tabId, requestId, "WARN",
      `Best-guess call failed: ${aborted ? "timeout" : err.message}`
    );
    throw err;
  }
}

// Builds the "more context" prompt — expand the existing short answer
// using the same article text. Strict on: ending on a complete sentence,
// answering substance (why/how/when/who/what next), and not regurgitating
// the headline. Hard ~480-char target so the model finishes naturally
// well inside the 500-char cap and we never need to truncate mid-thought.
function buildExpansionPrompt(headline, articleText, originalAnswer) {
  return (
    `The user got this short answer and clicked "More context". Write a longer, ` +
    `more substantive version using the article excerpt below.\n\n` +
    `WRITE 2–4 COMPLETE SENTENCES totaling 250–470 characters. Your last character ` +
    `MUST be a period, question mark, or exclamation point — never end mid-thought, ` +
    `never end with "...".\n\n` +
    `WHAT TO ADD\n` +
    `- Answer the implicit follow-up questions: why, how, when, who, what next.\n` +
    `- Specific facts: numbers, dates, names, mechanisms, sequence of events.\n` +
    `- For lists, add the remaining items in article order (cap at 10 total).\n` +
    `- For "who" answers, add what they did and why it matters.\n\n` +
    `WHAT TO AVOID\n` +
    `- Do NOT repeat the headline or restate the original short answer verbatim.\n` +
    `- Do NOT pad with filler ("this raises questions about…", "it remains to be ` +
    `seen…", "the situation continues to develop…").\n` +
    `- Do NOT quote the article verbatim — synthesize.\n` +
    `- Do NOT add prefixes ("Answer:", "More detail:", "Expanded:") or quotes.\n\n` +
    `ORIGINAL HEADLINE: ${headline || "(unknown)"}\n` +
    `ORIGINAL SHORT ANSWER: ${originalAnswer}\n\n` +
    `ARTICLE EXCERPT:\n${articleText}`
  );
}

// Posts the expansion prompt to the Worker. Returns
//   { answer, rawAnswer, aiCallMs, promptChars, workerStatus }.
async function askForMoreContext(headline, articleText, originalAnswer, requestId, tabId) {
  const prompt = buildExpansionPrompt(headline, articleText, originalAnswer);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  const startedAt = Date.now();
  sendDebugEvent(tabId, requestId, "INFO",
    `Expansion AI call sent | promptChars=${prompt.length} | articleChars=${articleText.length}`
  );
  try {
    const resp = await fetch(NOBAIT_WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: prompt }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const aiCallMs = Date.now() - startedAt;
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const detail = (data && (data.detail || data.error)) || `HTTP ${resp.status}`;
      throw new Error(`Worker error: ${detail}`);
    }
    const raw = String((data && data.summary) || "").trim();
    if (!raw) throw new Error("Empty expansion from worker");
    const answer = trimToCompleteSentence(raw, EXPANDED_MAX_CHARS);
    sendDebugEvent(tabId, requestId, "INFO",
      `Expansion answer in ${aiCallMs}ms (${answer.length}ch, raw=${raw.length}): "${answer.slice(0, 100)}"`
    );
    return {
      answer,
      rawAnswer: raw,
      aiCallMs,
      promptChars: prompt.length,
      workerStatus: resp.status,
    };
  } catch (err) {
    clearTimeout(timeoutId);
    const aborted = err && err.name === "AbortError";
    sendDebugEvent(tabId, requestId, "WARN",
      `Expansion failed: ${aborted ? "timeout" : err.message}`
    );
    throw err;
  }
}

// Looks up cached article text for the URL the user originally summarized,
// or refetches if expired/missing, then asks the worker for an expansion.
async function expandAnswer(resolvedUrl, headline, originalAnswer, requestId, tabId) {
  const cached = answerCache.get(resolvedUrl);
  let articleText = cached && cached.articleText;
  let usedHeadline = headline || (cached && cached.headline) || "";

  sendDebugEvent(tabId, requestId, "INFO",
    `Expansion starting | resolvedUrl=${resolvedUrl} | cached=${!!cached} | cachedTextLen=${(cached && cached.articleText && cached.articleText.length) || 0} | originalAnswerLen=${originalAnswer.length}`
  );

  if (!articleText) {
    sendDebugEvent(tabId, requestId, "INFO", `Expansion: cache miss, refetching article`);
    const article = await fetchArticleText(resolvedUrl, requestId);
    if (article.block) {
      throw new Error(`Article newly blocked (${article.block.kind}) — can't expand`);
    }
    if (!article.text || article.text.length < 50) {
      throw new Error(`Article unavailable for expansion (${article.text.length} chars)`);
    }
    articleText = article.text;
  }

  return await askForMoreContext(usedHeadline, articleText, originalAnswer, requestId, tabId);
}

// Parses a Google News RSS XML payload into { title, link, pubDate, source,
// sourceUrl } items using regex (DOMParser isn't available in service workers).
// Cap at 30 to avoid runaway parsing.
function parseRssItems(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null && items.length < 30) {
    const itemXml = match[1];
    const titleMatch = itemXml.match(
      /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i
    );
    const linkMatch = itemXml.match(/<link>([\s\S]*?)<\/link>/i);
    const pubDateMatch = itemXml.match(/<pubDate>([\s\S]*?)<\/pubDate>/i);
    const sourceTagMatch = itemXml.match(
      /<source[^>]*>([\s\S]*?)<\/source>/i
    );
    const sourceUrlMatch = itemXml.match(
      /<source[^>]+url=["']([^"']+)["']/i
    );
    items.push({
      title: (titleMatch ? titleMatch[1] : "").replace(/<[^>]+>/g, "").trim(),
      link: (linkMatch ? linkMatch[1] : "").trim(),
      pubDate: (pubDateMatch ? pubDateMatch[1] : "").trim(),
      source: (sourceTagMatch ? sourceTagMatch[1] : "").replace(/<[^>]+>/g, "").trim(),
      sourceUrl: (sourceUrlMatch ? sourceUrlMatch[1] : "").trim(),
    });
  }
  return items;
}

// Lightweight URL-resolve for alt-source candidates. Only follows HTTP
// redirects (no tab navigation) — Google News /rss/articles/ does an
// HTTP redirect, so this works for the common case and is fast.
async function resolveQuickViaHttp(url, requestId) {
  try {
    const u = new URL(url);
    if (u.hostname === "news.google.com") {
      const id = extractGoogleNewsArticleId(url);
      if (id) {
        const rssUrl = `https://news.google.com/rss/articles/${id}`;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), ALT_SOURCE_GN_QUICK_TIMEOUT_MS);
        try {
          const resp = await fetch(rssUrl, { redirect: "follow", signal: ctrl.signal });
          clearTimeout(timer);
          if (resp.url && !resp.url.includes("news.google.com")) return resp.url;
        } catch (e) {
          clearTimeout(timer);
        }
      }
    }
    return url;
  } catch {
    return url;
  }
}

// Returns the second-level/registrable-ish domain (e.g. "ft.com" from
// "www.ft.com" or "uk.reuters.com" → "reuters.com"). Cheap heuristic;
// good enough for "is this the same publisher" comparison.
function rootDomainOf(urlOrHost) {
  try {
    let host = urlOrHost;
    if (host.includes("/")) {
      host = new URL(urlOrHost).hostname;
    }
    host = host.toLowerCase().replace(/^www\./, "");
    const parts = host.split(".");
    if (parts.length <= 2) return host;
    // Handle co.uk, com.au, co.jp, etc. — keep last 3 parts in those cases.
    const tld2 = parts[parts.length - 2];
    const tld1 = parts[parts.length - 1];
    if (tld1.length === 2 && tld2.length <= 3) {
      return parts.slice(-3).join(".");
    }
    return parts.slice(-2).join(".");
  } catch {
    return "";
  }
}

// Searches Google News RSS for the headline, then walks the candidate list
// (up to ALT_SOURCE_MAX_ATTEMPTS) trying to find an article from a different
// publisher that isn't paywalled or bot-blocked. Each successful fetch is
// summarized with the same askWorkerForAnswer prompt so the answer style
// matches a normal NoBait answer.
//
// Returns either:
//   { found: true, source, publisher, articleUrl, articleTitle, articleDate,
//     answer, rawAnswer, attempts: [{source, url, reason}, ...] }
//   { found: false, attempts: [...], error? }
// Parses DuckDuckGo HTML search result links. DDG wraps result URLs in a
// /l/?uddg=<encoded URL> redirect, so we decode that to get the real
// destination. Returns [{url, title}, ...] in result order.
function parseDdgHtmlResults(html) {
  if (!html) return [];
  const results = [];
  const re = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null && results.length < 25) {
    let url = m[1];
    const title = m[2]
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\s+/g, " ")
      .trim();

    if (url.includes("/l/?uddg=")) {
      const um = url.match(/[?&]uddg=([^&]+)/);
      if (um) {
        try { url = decodeURIComponent(um[1]); } catch {}
      }
    }
    if (url.startsWith("//")) url = "https:" + url;
    if (!/^https?:\/\//.test(url)) continue;
    results.push({ url, title });
  }
  return results;
}

// Searches DuckDuckGo's HTML interface for `headline` and walks results
// looking for an article from a publisher different from `originalRoot`.
// Each candidate is fetched + block-checked + summarized. Used as a
// second-tier fallback when Google News RSS returns no usable candidates
// (often the case for FT/NYT-original stories where Google News clusters
// everything to the canonical publisher URL).
async function tryDuckDuckGoHtmlAlt(headline, originalRoot, requestId, attempts, remainingAttempts, tabId, style) {
  const useStyle = style || DEFAULT_STYLE;
  sendDebugEvent(tabId, requestId, "INFO",
    `DDG fallback starting | style=${useStyle} | query="${headline.slice(0, 80)}" | originalRoot=${originalRoot || "n/a"}`
  );

  // Build a query that biases toward news (DDG doesn't have a news vertical
  // available via HTML, but adding "news" or "site:" hints helps).
  const query = `${headline}`;
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

  let html;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const resp = await fetch(searchUrl, {
      signal: ctrl.signal,
      headers: { "Accept": "text/html" },
    });
    clearTimeout(timer);
    if (!resp.ok) {
      console.warn(`[NoBait BG] requestId=${requestId} | DDG search HTTP ${resp.status}`);
      return null;
    }
    html = await resp.text();
  } catch (err) {
    console.warn(`[NoBait BG] requestId=${requestId} | DDG search failed: ${err.message}`);
    return null;
  }

  const results = parseDdgHtmlResults(html);
  sendDebugEvent(tabId, requestId, "INFO", `DDG returned ${results.length} raw results`);

  // Filter to different publishers, dedupe by root domain.
  const seen = new Set([originalRoot]);
  const candidates = [];
  for (const r of results) {
    const root = rootDomainOf(r.url);
    if (!root) continue;
    if (seen.has(root)) continue;
    // Skip aggregators that won't have substantive article content
    if (
      root === "google.com" ||
      root === "youtube.com" ||
      root === "wikipedia.org" ||
      root === "reddit.com" ||
      root === "facebook.com" ||
      root === "twitter.com" ||
      root === "x.com" ||
      root === "linkedin.com" ||
      root === "duckduckgo.com"
    ) continue;
    seen.add(root);
    candidates.push(r);
    if (candidates.length >= 10) break;
  }

  sendDebugEvent(tabId, requestId, "INFO",
    `DDG: ${candidates.length} candidate(s) after dedupe and aggregator filter`
  );

  for (const candidate of candidates) {
    if (attempts.length >= remainingAttempts) break;
    const sourceName = candidate.title || rootDomainOf(candidate.url);
    sendDebugEvent(tabId, requestId, "INFO",
      `DDG try [${attempts.length + 1}/${remainingAttempts}]: ${rootDomainOf(candidate.url)} | ${candidate.url.slice(0, 100)}`
    );
    try {
      const article = await fetchArticleText(candidate.url, requestId);
      if (article.block) {
        const reason = `${article.block.kind} via DDG: ${article.block.publisher || article.block.reason || article.block.detectedFrom || "blocked"}`;
        attempts.push({ source: sourceName, url: candidate.url, reason });
        sendDebugEvent(tabId, requestId, "INFO", `→ DDG candidate blocked: ${reason}`);
        continue;
      }
      if (!article.text || article.text.length < 200) {
        attempts.push({ source: sourceName, url: candidate.url, reason: `text too short via DDG (${article.text.length} chars)` });
        sendDebugEvent(tabId, requestId, "INFO", `→ DDG candidate text too short: ${article.text.length} chars`);
        continue;
      }
      sendDebugEvent(tabId, requestId, "INFO", `→ DDG fetched OK: ${article.text.length} chars, summarizing (${useStyle})…`);
      const aiResult = await askWorkerForAnswer(headline, article.text, requestId, useStyle);
      sendDebugEvent(tabId, requestId, "INFO",
        `Alt source FOUND via DDG: ${sourceName} → ${candidate.url} | answer=${aiResult.answer.length} chars`
      );
      return {
        found: true,
        source: sourceName,
        publisher: rootDomainOf(candidate.url),
        articleUrl: candidate.url,
        articleTitle: article.articleTitle || candidate.title,
        articleDate: article.articleDate,
        answer: aiResult.answer,
        rawAnswer: aiResult.rawAnswer,
        searchEngine: "duckduckgo",
      };
    } catch (err) {
      attempts.push({ source: sourceName, url: candidate.url, reason: `via DDG: ${err.message}` });
      sendDebugEvent(tabId, requestId, "WARN", `→ DDG candidate error: ${err.message}`);
    }
  }

  return null;
}

async function findAlternativeSource(headline, originalUrl, articleDate, requestId, tabId, style) {
  const useStyle = style || DEFAULT_STYLE;
  sendDebugEvent(tabId, requestId,
    "INFO",
    `Alt source search starting | style=${useStyle} | query="${(headline || "").slice(0, 100)}" | originalUrl=${originalUrl} | date=${articleDate || "n/a"}`
  );

  if (!headline || headline.trim().length < 5) {
    throw new Error("Need a headline to search — none was captured for this link");
  }

  const originalRoot = rootDomainOf(originalUrl);
  console.log(`[NoBait BG] requestId=${requestId} | Excluding original publisher root: ${originalRoot || "(unknown)"}`);

  // 1. Hit Google News RSS search
  const searchUrl =
    `https://news.google.com/rss/search?q=${encodeURIComponent(headline)}` +
    `&hl=en-US&gl=US&ceid=US:en`;

  let xml;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ALT_SOURCE_SEARCH_TIMEOUT_MS);
    const resp = await fetch(searchUrl, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!resp.ok) {
      sendDebugEvent(tabId, requestId, "WARN", `Google News search HTTP ${resp.status} — will fall through to DDG`);
    } else {
      xml = await resp.text();
    }
  } catch (err) {
    sendDebugEvent(tabId, requestId, "WARN", `Google News search failed: ${err.message} — will fall through to DDG`);
  }

  const items = xml ? parseRssItems(xml) : [];
  sendDebugEvent(tabId, requestId, "INFO",
    `Google News RSS returned ${items.length} raw items`
  );

  // 2. Dedupe by source name AND pre-filter by root domain.
  // Checking rootDomainOf(item.sourceUrl) before resolution saves every
  // attempt slot on same-publisher affiliates. Google News often returns
  // community blogs or sub-sites of the original publisher (FanGraphs
  // has AZ Snake Pit, That Balls Outta Here, etc. all resolving to
  // fangraphs.com). Reject those cheaply here instead of burning an
  // attempt on a slow resolve + fetch that will fail anyway.
  const seenSources = new Set([originalRoot]); // seed with original root
  const candidates = [];
  for (const item of items) {
    const sourceKey = (item.source || item.sourceUrl || item.link).toLowerCase();
    if (seenSources.has(sourceKey)) continue;
    seenSources.add(sourceKey);

    // Domain pre-filter: if the RSS <source url=""> resolves to the same
    // root domain as the original article, skip without counting as an attempt.
    if (item.sourceUrl) {
      const sourceRoot = rootDomainOf(item.sourceUrl);
      if (sourceRoot && originalRoot && sourceRoot === originalRoot) {
        sendDebugEvent(tabId, requestId, "INFO",
          `Alt source pre-filter skip: "${item.source}" (sourceUrl=${item.sourceUrl}, root=${sourceRoot} matches original)`
        );
        continue;
      }
    }

    candidates.push(item);
    if (candidates.length >= 15) break; // gather extras in case many fail
  }

  sendDebugEvent(tabId, requestId, "INFO",
    `Alt source: ${candidates.length} candidate(s) survive pre-filter (out of ${items.length} RSS results)`
  );

  // 3. Try each candidate up to the cap. Even if Google News yielded nothing
  // useful here, we still continue to the DDG fallback below.
  const attempts = [];
  for (const candidate of candidates) {
    if (attempts.length >= ALT_SOURCE_MAX_ATTEMPTS) break;
    const sourceName = candidate.source || candidate.sourceUrl || "(unknown source)";
    sendDebugEvent(tabId, requestId, "INFO",
      `Alt source try [${attempts.length + 1}/${ALT_SOURCE_MAX_ATTEMPTS}]: ${sourceName} | sourceUrl=${candidate.sourceUrl || "n/a"} | gnLink=${candidate.link.slice(0, 80)}…`
    );

    // Cheap skip: source URL says it's the same publisher.
    const sourceRoot = rootDomainOf(candidate.sourceUrl || candidate.link);
    if (originalRoot && sourceRoot && sourceRoot === originalRoot) {
      attempts.push({ source: sourceName, url: candidate.sourceUrl || candidate.link, reason: "same publisher as original" });
      sendDebugEvent(tabId, requestId, "INFO", `→ skipped: same publisher (${sourceRoot})`);
      continue;
    }

    try {
      // Resolve the Google News /rss/articles/ link to the publisher URL.
      const resolved = await resolveQuickViaHttp(candidate.link, requestId);

      // Recheck domain after resolve (some items have a generic source URL).
      const resolvedRoot = rootDomainOf(resolved);
      if (originalRoot && resolvedRoot && resolvedRoot === originalRoot) {
        attempts.push({ source: sourceName, url: resolved, reason: "same publisher as original (post-resolve)" });
        sendDebugEvent(tabId, requestId, "INFO", `→ skipped post-resolve: redirected back to original publisher (${resolved.slice(0, 100)})`);
        continue;
      }
      if (resolved.includes("news.google.com")) {
        attempts.push({ source: sourceName, url: resolved, reason: "couldn't resolve Google News redirect" });
        sendDebugEvent(tabId, requestId, "WARN", `→ skipped: Google News redirect didn't fire`);
        continue;
      }

      sendDebugEvent(tabId, requestId, "INFO", `→ resolved to ${resolved}`);

      // Fetch + run block detection.
      const article = await fetchArticleText(resolved, requestId);
      if (article.block) {
        const reason = `${article.block.kind}: ${article.block.publisher || article.block.reason || article.block.detectedFrom || "blocked"}`;
        attempts.push({ source: sourceName, url: resolved, reason });
        sendDebugEvent(tabId, requestId, "INFO", `→ blocked: ${reason}`);
        continue;
      }
      if (!article.text || article.text.length < 200) {
        attempts.push({ source: sourceName, url: resolved, reason: `text too short (${article.text.length} chars)` });
        sendDebugEvent(tabId, requestId, "INFO", `→ text too short: ${article.text.length} chars`);
        continue;
      }

      sendDebugEvent(tabId, requestId, "INFO", `→ fetched OK: ${article.text.length} chars, asking AI for summary (${useStyle})…`);

      // Summarize with the same prompt the main pipeline uses.
      let aiResult;
      try {
        aiResult = await askWorkerForAnswer(headline, article.text, requestId, useStyle);
      } catch (err) {
        attempts.push({ source: sourceName, url: resolved, reason: `summary failed: ${err.message}` });
        sendDebugEvent(tabId, requestId, "WARN", `→ AI summary failed: ${err.message}`);
        continue;
      }

      sendDebugEvent(tabId, requestId, "INFO",
        `Alt source FOUND via Google News: ${sourceName} (${resolvedRoot}) → ${resolved} | answer=${aiResult.answer.length} chars`
      );
      return {
        found: true,
        source: sourceName,
        publisher: resolvedRoot || sourceName,
        articleUrl: resolved,
        articleTitle: candidate.title || article.articleTitle || null,
        articleDate: article.articleDate || candidate.pubDate || null,
        answer: aiResult.answer,
        rawAnswer: aiResult.rawAnswer,
        attempts,
      };
    } catch (err) {
      attempts.push({ source: sourceName, url: candidate.link, reason: err.message });
    }
  }

  // Google News exhausted. Try DuckDuckGo HTML as a second tier — DDG
  // doesn't cluster syndicated stories the way Google News does, so for
  // FT/NYT-original articles where Google News routes everything back to
  // the original publisher, DDG often finds genuine third-party coverage.
  const remainingAttempts = ALT_SOURCE_MAX_ATTEMPTS;
  console.log(
    `[NoBait BG] requestId=${requestId} | Google News yielded no usable alt; trying DuckDuckGo HTML (${attempts.length} attempts so far)`
  );
  const ddgResult = await tryDuckDuckGoHtmlAlt(
    headline,
    originalRoot,
    requestId,
    attempts,
    attempts.length + remainingAttempts,
    tabId,
    useStyle
  );
  if (ddgResult && ddgResult.found) {
    return { ...ddgResult, attempts };
  }

  console.log(
    `[NoBait BG] requestId=${requestId} | Alt source: all ${attempts.length} attempts failed/blocked (Google News + DuckDuckGo)`
  );
  return { found: false, attempts };
}

// Builds and opens a search-engine query in a new background tab.
function openSearchTab(engine, query) {
  const q = encodeURIComponent(query || "");
  let url;
  if (engine === "duckduckgo") {
    url = `https://duckduckgo.com/?q=${q}`;
  } else {
    url = `https://www.google.com/search?q=${q}`;
  }
  chrome.tabs.create({ url, active: true }).catch((err) => {
    console.warn(`[NoBait BG] openSearchTab failed: ${err.message}`);
  });
}

// ── Message listener ─────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender && sender.tab && sender.tab.id;

  if (message.type === "resolve-url") {
    const originalUrl = message.url;
    const linkText = typeof message.linkText === "string" ? message.linkText : "";
    const requestId = message.requestId || "unknown";

    console.log(
      `[NoBait BG] requestId=${requestId} | Received resolve request for: ${originalUrl}`
    );

    resolveUrl(originalUrl, requestId)
      .then((result) => {
        sendResponse(result);
        if (result && result.success && typeof tabId === "number") {
          pushClickbaitAnswer(tabId, requestId, linkText, originalUrl, result.resolvedUrl);
        }
      })
      .catch((error) => {
        console.error(`[NoBait BG] requestId=${requestId} | Unexpected error:`, error);
        sendResponse({
          success: false,
          error: error.message,
          errorName: error.name,
          errorStack: error.stack || "N/A",
          originalUrl,
          requestId,
        });
      });

    return true; // async sendResponse
  }

  if (message.type === "try-archive") {
    const requestId = message.requestId || "unknown";
    const url = message.url;
    const headline = typeof message.headline === "string" ? message.headline : "";
    getSettings().then((settings) => tryArchiveSummary(url, headline, requestId, tabId, settings.summaryStyle))
      .then((result) => {
        if (typeof tabId === "number") {
          chrome.tabs
            .sendMessage(tabId, { type: "archive-result", requestId, ...result })
            .catch(() => {});
        }
      })
      .catch((err) => {
        if (typeof tabId === "number") {
          chrome.tabs
            .sendMessage(tabId, {
              type: "archive-result",
              requestId,
              found: false,
              error: err.message,
            })
            .catch(() => {});
        }
      });
    return false;
  }

  if (message.type === "try-best-guess") {
    const requestId = message.requestId || "unknown";
    bestGuessSummary(
      message.headline || "",
      message.originalUrl || "",
      message.resolvedUrl || "",
      message.articleDate || null,
      requestId,
      tabId
    )
      .then((result) => {
        if (typeof tabId === "number") {
          chrome.tabs
            .sendMessage(tabId, { type: "best-guess-result", requestId, ...result })
            .catch(() => {});
        }
      })
      .catch((err) => {
        if (typeof tabId === "number") {
          chrome.tabs
            .sendMessage(tabId, {
              type: "best-guess-result",
              requestId,
              error: err.message,
            })
            .catch(() => {});
        }
      });
    return false;
  }

  if (message.type === "open-search") {
    openSearchTab(message.engine, message.query);
    return false;
  }

  if (message.type === "try-fallback") {
    // Unified handler for manually invoking jsonLd / metaDesc / cookies /
    // amp / twelveFt fallbacks (the ones that already exist but were only
    // run automatically). Re-uses the cached article text/HTML when present
    // so jsonLd and metaDesc are essentially instant.
    const requestId = message.requestId || "unknown";
    const method = message.method;
    const headline = message.headline || "";
    const resolvedUrl = message.resolvedUrl || "";
    const originalUrl = message.originalUrl || resolvedUrl;
    runManualFallback(method, { headline, originalUrl, resolvedUrl, requestId, tabId })
      .then((result) => {
        if (typeof tabId === "number") {
          chrome.tabs
            .sendMessage(tabId, {
              type: "fallback-result",
              requestId,
              method,
              ...result,
            })
            .catch(() => {});
        }
      })
      .catch((err) => {
        if (typeof tabId === "number") {
          chrome.tabs
            .sendMessage(tabId, {
              type: "fallback-result",
              requestId,
              method,
              found: false,
              error: err.message,
            })
            .catch(() => {});
        }
      });
    return false;
  }

  if (message.type === "try-alt-source") {
    const requestId = message.requestId || "unknown";
    // Use headline if present, else fall back to articleTitle (extracted
    // from the fetched HTML). For Google News icon-only links the anchor
    // textContent is empty, but og:title from the resolved page gives us
    // a real query.
    const queryHeadline =
      (message.headline && message.headline.trim()) ||
      (message.articleTitle && message.articleTitle.trim()) ||
      "";
    getSettings().then((settings) => findAlternativeSource(
      queryHeadline,
      message.originalUrl || message.resolvedUrl || "",
      message.articleDate || null,
      requestId,
      tabId,
      settings.summaryStyle
    ))
      .then((result) => {
        if (typeof tabId === "number") {
          chrome.tabs
            .sendMessage(tabId, { type: "alt-source-result", requestId, ...result })
            .catch(() => {});
        }
      })
      .catch((err) => {
        if (typeof tabId === "number") {
          chrome.tabs
            .sendMessage(tabId, {
              type: "alt-source-result",
              requestId,
              found: false,
              attempts: [],
              error: err.message,
            })
            .catch(() => {});
        }
      });
    return false;
  }

  if (message.type === "expand-answer") {
    const requestId = message.requestId || "unknown";
    expandAnswer(
      message.resolvedUrl || "",
      message.headline || "",
      message.originalAnswer || "",
      requestId,
      tabId
    )
      .then((result) => {
        if (typeof tabId === "number") {
          chrome.tabs
            .sendMessage(tabId, { type: "more-context-result", requestId, ...result })
            .catch(() => {});
        }
      })
      .catch((err) => {
        if (typeof tabId === "number") {
          chrome.tabs
            .sendMessage(tabId, {
              type: "more-context-result",
              requestId,
              error: err.message,
            })
            .catch(() => {});
        }
      });
    return false;
  }

  return false;
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== "install") return;
  try {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    if (!stored[SETTINGS_KEY]) {
      await chrome.storage.local.set({
        [SETTINGS_KEY]: {
          summaryStyle: DEFAULT_STYLE,
          fallbacks: JSON.parse(JSON.stringify(DEFAULT_FALLBACKS)),
        },
      });
      console.log("[NoBait BG] First install: initialized settings with defaults.");
    }
  } catch (err) {
    console.warn("[NoBait BG] onInstalled settings init failed:", err.message);
  }
});

console.log(
  "[NoBait BG] Service worker loaded — resolve, summarize, paywall-detect, archive-lookup, best-guess, open-search"
);