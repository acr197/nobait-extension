// background.js — Service worker for NoBait v2
// Resolves redirect chains via: (1) no-tab fetch/batchexecute, (2) tab navigation fallback,
// (3) HTTP fetch + HTML parsing last resort.

const FETCH_TIMEOUT_MS = 8000;
const TAB_HARD_TIMEOUT_MS = 12000;
const TAB_SETTLE_DELAY_MS = 1500;
const NOTAB_TIMEOUT_MS = 4000;

// ── Helpers ──────────────────────────────────────────────────────────

// Extract the CBM article ID from a Google News URL.
// Handles /articles/CBM..., /rss/articles/CBM..., and /read/CBM... paths.
function extractGoogleNewsArticleId(url) {
  const match = url.match(/\/(?:rss\/articles|articles|read)\/(CBM[^/?#]+)/);
  return match ? match[1] : null;
}

// Parse a batchexecute response and return the first non-Google-News https URL.
// Strips the )]}' safety prefix before scanning.
function parseGoogleBatchexecuteResponse(text) {
  console.log("[NoBait BG] parseGoogleBatchexecuteResponse | raw response length:", text.length);
  const clean = text.replace(/^\)\]\}'\s*/, "");
  const pattern = /"(https:\/\/(?!news\.google\.com\/)[^"]+)"/g;
  let match;
  while ((match = pattern.exec(clean)) !== null) {
    const candidate = match[1];
    // Skip anything with escape sequences — not a real article URL
    if (candidate.includes("\\")) continue;
    return candidate;
  }
  return null;
}

// ── Strategy 1a: Google News batchexecute decoder ────────────────────
// Fetches the article page to extract signature + timestamp, then POSTs
// to batchexecute with the Fbv4je RPC to get the publisher URL.
// Payload shape matches SSujitX nodejs reference exactly — do not alter
// the inner array structure or element order without re-testing.

async function resolveViaGoogleNewsBatchexecute(articleId, requestId, signal) {
  console.log(`[NoBait BG] requestId=${requestId} | batchexecute: starting for articleId=${articleId}`);

  // Step 1: fetch the article page and extract data-n-a-sg and data-n-a-ts
  const pageUrl = `https://news.google.com/articles/${articleId}`;
  let pageHtml;
  try {
    const pageResp = await fetch(pageUrl, { redirect: "follow", signal });
    pageHtml = await pageResp.text();
  } catch (err) {
    console.warn(`[NoBait BG] requestId=${requestId} | batchexecute: page fetch failed: ${err.message}`);
    return null;
  }

  const sgMatch = pageHtml.match(/data-n-a-sg="([^"]+)"/);
  const tsMatch = pageHtml.match(/data-n-a-ts="([^"]+)"/);
  if (!sgMatch || !tsMatch) {
    console.warn(`[NoBait BG] requestId=${requestId} | batchexecute: signature/timestamp not found in page HTML`);
    return null;
  }

  const signature = sgMatch[1];
  const timestamp = Number(tsMatch[1]);
  console.log(`[NoBait BG] requestId=${requestId} | batchexecute: sig=${signature.slice(0, 8)}… ts=${timestamp}`);

  // Step 2: POST to batchexecute
  // Inner JSON is a doubly-serialized string passed as the second element of the RPC tuple.
  // Array structure is verbatim from SSujitX reference — element order and types both matter.
  const innerPayload = JSON.stringify([
    "garturlreq",
    [
      [1, null, [1, null, null, 1], [1, "en", [0, 1], 0, 1], null, null, 1],
      "en",
      null,
      null,
      [1, null, [1, null, null, 1], [1, "en", [0, 1], 0, 1], null, null, 1],
      null,
      [1, null, [1, null, null, 1], [1, "en", [0, 1], 0, 1], null, null, 1],
    ],
    articleId,
    timestamp,
    signature,
  ]);

  const outerPayload = JSON.stringify([[["Fbv4je", innerPayload, null, "generic"]]]);
  const body = "f.req=" + encodeURIComponent(outerPayload);

  let postResp;
  try {
    postResp = await fetch(
      "https://news.google.com/_/DotsSplashUi/data/batchexecute",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "Referer": "https://news.google.com/",
        },
        body,
        redirect: "follow",
        signal,
      }
    );
  } catch (err) {
    console.warn(`[NoBait BG] requestId=${requestId} | batchexecute: POST failed: ${err.message}`);
    return null;
  }

  if (!postResp.ok) {
    console.warn(`[NoBait BG] requestId=${requestId} | batchexecute: POST returned HTTP ${postResp.status} — falling through`);
    return null;
  }

  const responseText = await postResp.text();
  const resolvedUrl = parseGoogleBatchexecuteResponse(responseText);

  if (!resolvedUrl) {
    console.warn(`[NoBait BG] requestId=${requestId} | batchexecute: could not extract publisher URL from response`);
    return null;
  }

  console.log(`[NoBait BG] requestId=${requestId} | batchexecute: resolved → ${resolvedUrl}`);
  return resolvedUrl;
}

// ── Strategy 1: No-tab resolver (fetch only, no background tab) ──────
// For Google News CBM URLs: tries batchexecute decode.
// For all others: HEAD then GET with redirect:follow.
// Hard timeout: NOTAB_TIMEOUT_MS. Falls through to tab-navigation on any failure.

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
    // Google News CBM articles — use batchexecute for direct publisher URL
    if (url.hostname === "news.google.com") {
      const articleId = extractGoogleNewsArticleId(originalUrl);
      if (articleId) {
        const result = await resolveViaGoogleNewsBatchexecute(articleId, requestId, controller.signal);
        clearTimeout(timeoutId);
        if (result) return { url: result, method: "batchexecute" };
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
      // HEAD failed (405, network error, CORS) — continue to GET
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

// ── Strategy 2: Tab-based navigation (follows JS redirects) ─────────
// Opens the URL in a hidden background tab, lets the browser execute
// JavaScript, and captures the final URL after all redirects complete.
// This is the known-working path and serves as last-resort fallback.

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
        // If URL already changed from original, settle quickly
        const delay =
          finalUrl !== originalUrl ? 500 : TAB_SETTLE_DELAY_MS;
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

// ── Strategy 3: HTTP redirect (HEAD then GET) ────────────────────────

async function resolveViaFetch(originalUrl, requestId) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    // Try HEAD first (fast, small response)
    const headResp = await fetch(originalUrl, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (headResp.redirected && headResp.url !== originalUrl) {
      return { url: headResp.url, method: "http-redirect", status: headResp.status };
    }

    // HEAD didn't redirect — try GET (some servers only redirect GET)
    const getController = new AbortController();
    const getTimeout = setTimeout(() => getController.abort(), FETCH_TIMEOUT_MS);

    const getResp = await fetch(originalUrl, {
      method: "GET",
      redirect: "follow",
      signal: getController.signal,
    });
    clearTimeout(getTimeout);

    if (getResp.url !== originalUrl) {
      return { url: getResp.url, method: "http-redirect-get", status: getResp.status };
    }

    // Parse HTML for client-side redirect indicators
    const html = await getResp.text();
    const htmlResult = extractRedirectFromHtml(html, originalUrl);
    if (htmlResult) {
      return { url: htmlResult.url, method: htmlResult.method, status: getResp.status };
    }

    return null;
  } catch (error) {
    clearTimeout(timeoutId);
    console.warn(
      `[NoBait BG] requestId=${requestId} | Fetch failed: ${error.name}: ${error.message}`
    );
    return null;
  }
}

// ── HTML redirect extraction ─────────────────────────────────────────

function extractRedirectFromHtml(html, originalUrl) {
  let originalOrigin;
  try {
    originalOrigin = new URL(originalUrl).origin;
  } catch {
    return null;
  }

  // 1. Meta refresh tag (works regardless of origin)
  const metaRefreshPatterns = [
    /<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^"']*?url=["']?([^"'\s;>]+)/i,
    /<meta[^>]+content=["'][^"']*?url=["']?([^"'\s;>]+)["']?[^>]+http-equiv=["']refresh["']/i,
  ];
  for (const pattern of metaRefreshPatterns) {
    const m = html.match(pattern);
    if (m && m[1] && m[1] !== originalUrl) {
      return { url: m[1], method: "meta-refresh" };
    }
  }

  // 2. Canonical link (only if pointing to a DIFFERENT origin)
  const canonicalPatterns = [
    /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i,
    /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i,
  ];
  for (const pattern of canonicalPatterns) {
    const m = html.match(pattern);
    if (m && m[1]) {
      try {
        if (new URL(m[1]).origin !== originalOrigin) {
          return { url: m[1], method: "canonical" };
        }
      } catch {}
    }
  }

  // 3. og:url meta tag (only if pointing to a DIFFERENT origin)
  const ogUrlPatterns = [
    /<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:url["']/i,
  ];
  for (const pattern of ogUrlPatterns) {
    const m = html.match(pattern);
    if (m && m[1]) {
      try {
        if (new URL(m[1]).origin !== originalOrigin) {
          return { url: m[1], method: "og:url" };
        }
      } catch {}
    }
  }

  // 4. JavaScript redirect patterns
  const jsRedirectPatterns = [
    /window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/i,
    /window\.location\.replace\(\s*["']([^"']+)["']\s*\)/i,
    /document\.location(?:\.href)?\s*=\s*["']([^"']+)["']/i,
  ];
  for (const pattern of jsRedirectPatterns) {
    const m = html.match(pattern);
    if (m && m[1] && m[1] !== originalUrl && m[1].startsWith("http")) {
      return { url: m[1], method: "js-redirect" };
    }
  }

  return null;
}

// ── Main resolver pipeline ───────────────────────────────────────────

async function resolveUrl(originalUrl, requestId) {
  console.log(
    `[NoBait BG] requestId=${requestId} | Starting resolution for: ${originalUrl}`
  );

  // ── Strategy 1: No-tab fetch resolver (fast, no background tab) ───────
  // For Google News: batchexecute decode. For others: HEAD/GET with redirect:follow.
  const noTabResult = await resolveViaNoTab(originalUrl, requestId);

  if (noTabResult && noTabResult.url !== originalUrl) {
    console.log(
      `[NoBait BG] requestId=${requestId} | No-tab resolver succeeded\n` +
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
      requestId,
    };
  }

  // ── Strategy 2: Tab navigation (last-resort — follows JS redirects) ───
  console.log(
    `[NoBait BG] requestId=${requestId} | No-tab found no redirect, trying tab navigation…`
  );

  const tabResult = await resolveViaTab(originalUrl, requestId);

  if (tabResult && tabResult !== originalUrl) {
    console.log(
      `[NoBait BG] requestId=${requestId} | Tab navigation resolved\n` +
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
      requestId,
    };
  }

  // ── Strategy 3: HTTP fetch + HTML parsing ─────────────────────────────
  console.log(
    `[NoBait BG] requestId=${requestId} | Tab didn't redirect, trying fetch…`
  );

  const fetchResult = await resolveViaFetch(originalUrl, requestId);

  if (fetchResult) {
    console.log(
      `[NoBait BG] requestId=${requestId} | Fetch resolved\n` +
        `  original : ${originalUrl}\n` +
        `  resolved : ${fetchResult.url}\n` +
        `  method   : ${fetchResult.method}`
    );
    return {
      success: true,
      resolvedUrl: fetchResult.url,
      originalUrl,
      status: fetchResult.status,
      redirected: true,
      method: fetchResult.method,
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
    requestId,
  };
}

// ── Message listener ─────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "resolve-url") return false;

  const originalUrl = message.url;
  const requestId = message.requestId || "unknown";

  console.log(
    `[NoBait BG] requestId=${requestId} | Received resolve request for: ${originalUrl}`
  );

  resolveUrl(originalUrl, requestId)
    .then((result) => sendResponse(result))
    .catch((error) => {
      console.error(
        `[NoBait BG] requestId=${requestId} | Unexpected error:`,
        error
      );
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
});

console.log(
  "[NoBait BG] Service worker loaded — strategies: batchexecute, fetch-head/get, tab-navigation, html-parse"
);
