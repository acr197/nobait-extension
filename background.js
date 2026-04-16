// background.js — Service worker for NoBait v2
// Resolves redirect chains via tab navigation (follows JS redirects),
// HTTP redirects, and HTML parsing fallbacks.

const FETCH_TIMEOUT_MS = 8000;
const TAB_HARD_TIMEOUT_MS = 12000;
const TAB_SETTLE_DELAY_MS = 1500;

// ── Strategy 1: Tab-based navigation (follows JS redirects) ─────────
// Opens the URL in a hidden background tab, lets the browser execute
// JavaScript, and captures the final URL after all redirects complete.

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
        resolve(null); // Signal failure so we fall through to fetch strategies
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

// ── Strategy 2: HTTP redirect (HEAD then GET) ────────────────────────

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

    return null; // No redirect found
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

  // ── Strategy 1: Tab navigation (most reliable — follows JS redirects) ──
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

  // ── Strategy 2: HTTP fetch + HTML parsing (fallback) ──────────────────
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
  "[NoBait BG] Service worker loaded — strategies: tab-navigation, http-redirect, html-parse"
);
