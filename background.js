// background.js — Service worker for NoBait v2
// Resolves redirect chains via URL decoding, HTTP redirects, and HTML parsing

const FETCH_TIMEOUT_MS = 8000;

// ── Google News URL decoder ──────────────────────────────────────────

function tryDecodeGoogleNewsUrl(url) {
  try {
    const urlObj = new URL(url);
    if (!urlObj.hostname.includes("news.google.com")) return null;

    // Extract article ID from various Google News URL formats
    const match = urlObj.pathname.match(
      /\/(?:read|rss\/articles|articles)\/(CB[A-Za-z0-9_-]+)/
    );
    if (!match) return null;

    const articleId = match[1];
    // Base64url → standard base64
    const base64 = articleId.replace(/-/g, "+").replace(/_/g, "/");
    const padding = "=".repeat((4 - (base64.length % 4)) % 4);
    const binaryStr = atob(base64 + padding);

    // The protobuf-encoded bytes contain the article URL as a plain string.
    // Extract it by scanning the decoded bytes for HTTP URLs.
    const bytes = new Uint8Array([...binaryStr].map((c) => c.charCodeAt(0)));
    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);

    // Find the first https:// URL in the decoded data
    const urlMatch = decoded.match(/https?:\/\/[^\s\x00-\x1f\x7f-\x9f]+/);
    if (urlMatch) {
      // Remove trailing non-URL characters that might have leaked from protobuf
      let found = urlMatch[0].replace(/[^\x20-\x7e]+$/, "");
      return found;
    }

    return null;
  } catch (e) {
    console.warn("[NoBait BG] Google News URL decode failed:", e.message);
    return null;
  }
}

// ── HTML-based redirect extraction ───────────────────────────────────

function extractRedirectFromHtml(html, originalUrl) {
  // 1. Meta refresh tag
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

  // 2. Canonical link
  const canonicalPatterns = [
    /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i,
    /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i,
  ];
  for (const pattern of canonicalPatterns) {
    const m = html.match(pattern);
    if (m && m[1] && m[1] !== originalUrl) {
      return { url: m[1], method: "canonical" };
    }
  }

  // 3. og:url meta tag
  const ogUrlPatterns = [
    /<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:url["']/i,
  ];
  for (const pattern of ogUrlPatterns) {
    const m = html.match(pattern);
    if (m && m[1] && m[1] !== originalUrl) {
      return { url: m[1], method: "og:url" };
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

// ── Main resolver ────────────────────────────────────────────────────

async function resolveUrl(originalUrl, requestId) {
  // ── Strategy 1: Direct URL decoding (Google News, etc.) ──────────
  const decodedUrl = tryDecodeGoogleNewsUrl(originalUrl);
  if (decodedUrl) {
    console.log(
      `[NoBait BG] requestId=${requestId} | Decoded URL from article ID\n` +
        `  original : ${originalUrl}\n` +
        `  decoded  : ${decodedUrl}\n` +
        `  method   : url-decode`
    );
    return {
      success: true,
      resolvedUrl: decodedUrl,
      originalUrl,
      status: 200,
      redirected: true,
      method: "url-decode",
      requestId,
    };
  }

  // ── Strategy 2: HTTP-level redirect (HEAD request) ───────────────
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
    console.warn(
      `[NoBait BG] requestId=${requestId} | HEAD fetch aborted after ${FETCH_TIMEOUT_MS}ms`
    );
  }, FETCH_TIMEOUT_MS);

  try {
    const headResponse = await fetch(originalUrl, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (headResponse.redirected && headResponse.url !== originalUrl) {
      console.log(
        `[NoBait BG] requestId=${requestId} | HTTP redirect resolved\n` +
          `  original : ${originalUrl}\n` +
          `  resolved : ${headResponse.url}\n` +
          `  status   : ${headResponse.status}`
      );
      return {
        success: true,
        resolvedUrl: headResponse.url,
        originalUrl,
        status: headResponse.status,
        redirected: true,
        method: "http-redirect",
        requestId,
      };
    }

    // ── Strategy 3: Parse HTML for client-side redirects ───────────
    console.log(
      `[NoBait BG] requestId=${requestId} | No HTTP redirect, trying HTML parsing…`
    );

    const getController = new AbortController();
    const getTimeoutId = setTimeout(() => {
      getController.abort();
    }, FETCH_TIMEOUT_MS);

    try {
      const getResponse = await fetch(originalUrl, {
        method: "GET",
        redirect: "follow",
        signal: getController.signal,
      });
      clearTimeout(getTimeoutId);

      // Check if GET itself resolved to a different URL
      if (getResponse.url !== originalUrl) {
        console.log(
          `[NoBait BG] requestId=${requestId} | GET redirect resolved\n` +
            `  original : ${originalUrl}\n` +
            `  resolved : ${getResponse.url}`
        );
        return {
          success: true,
          resolvedUrl: getResponse.url,
          originalUrl,
          status: getResponse.status,
          redirected: true,
          method: "http-redirect-get",
          requestId,
        };
      }

      const html = await getResponse.text();
      const htmlRedirect = extractRedirectFromHtml(html, originalUrl);

      if (htmlRedirect) {
        console.log(
          `[NoBait BG] requestId=${requestId} | HTML redirect found\n` +
            `  original : ${originalUrl}\n` +
            `  resolved : ${htmlRedirect.url}\n` +
            `  method   : ${htmlRedirect.method}`
        );
        return {
          success: true,
          resolvedUrl: htmlRedirect.url,
          originalUrl,
          status: getResponse.status,
          redirected: true,
          method: htmlRedirect.method,
          requestId,
        };
      }

      // No redirect found at all
      console.log(
        `[NoBait BG] requestId=${requestId} | No redirect detected\n` +
          `  original : ${originalUrl}\n` +
          `  status   : ${headResponse.status}`
      );
      return {
        success: true,
        resolvedUrl: originalUrl,
        originalUrl,
        status: headResponse.status,
        redirected: false,
        method: "none",
        requestId,
      };
    } catch (getError) {
      clearTimeout(getTimeoutId);
      // GET failed but HEAD succeeded — return HEAD result
      console.warn(
        `[NoBait BG] requestId=${requestId} | GET fallback failed: ${getError.message}`
      );
      return {
        success: true,
        resolvedUrl: originalUrl,
        originalUrl,
        status: headResponse.status,
        redirected: false,
        method: "none",
        requestId,
      };
    }
  } catch (error) {
    clearTimeout(timeoutId);
    const reason =
      error.name === "AbortError"
        ? `Fetch timed out after ${FETCH_TIMEOUT_MS}ms`
        : error.message;
    console.error(
      `[NoBait BG] requestId=${requestId} | Fetch FAILED\n` +
        `  error: ${error.name}: ${error.message}\n` +
        `  stack: ${error.stack || "N/A"}`
    );
    return {
      success: false,
      error: reason,
      errorName: error.name,
      errorStack: error.stack || "N/A",
      originalUrl,
      requestId,
    };
  }
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
  "[NoBait BG] Service worker loaded — strategies: url-decode, http-redirect, html-parse"
);
