// NoBait - Content Script
// Trigger detection (long-click, shift+click, ctrl+click), news URL filtering, and popup UI

(function () {
  "use strict";

  // --- Configuration ---
  const LONG_PRESS_MS = 800;
  const MOVE_THRESHOLD = 10;
  const ANCHOR_TRAVERSAL_DEPTH = 10;

  // --- Layer 1: blocked non-news domains ---
  const BLOCKED_DOMAINS = [
    // Social media
    "twitter.com", "x.com", "facebook.com", "instagram.com", "tiktok.com",
    "linkedin.com", "reddit.com", "threads.net", "pinterest.com",
    // Video
    "youtube.com", "youtu.be", "vimeo.com", "twitch.tv",
    // Shopping
    "amazon.com", "ebay.com", "etsy.com", "walmart.com", "target.com", "shopify.com",
    // Tech / apps
    "github.com", "stackoverflow.com", "notion.so", "figma.com",
    "docs.google.com", "drive.google.com",
  ];

  // --- Layer 1: blocked search engine paths ---
  const BLOCKED_SEARCH_PATHS = [
    { host: "google.com", path: "/search" },
    { host: "bing.com", path: "/search" },
    { host: "duckduckgo.com", path: "/" },
  ];

  // --- Layer 2: article-like path keywords ---
  const ARTICLE_PATH_KEYWORDS = [
    "/article/", "/story/", "/news/", "/post/", "/blog/",
    "/opinion/", "/analysis/", "/report/",
  ];

  // --- Layer 2: article-like query params ---
  const ARTICLE_QUERY_KEYS = ["article", "story", "p"];

  // --- Layer 2: news-related hostname fragments ---
  const NEWS_HOST_WORDS = [
    "news", "press", "times", "post", "journal", "herald",
    "gazette", "tribune", "wire", "report", "daily", "weekly",
  ];

  // --- State ---
  let pressTimer = null;
  let startX = 0;
  let startY = 0;
  let activePopupHost = null;
  let longPressTriggered = false;

  // --- Event listeners ---
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("pointermove", onPointerMove, true);
  document.addEventListener("pointerup", onPointerUp, true);
  document.addEventListener("pointercancel", onPointerCancel, true);
  document.addEventListener("click", onClickCapture, true);

  // =========================================================================
  // TRIGGER DETECTION
  // =========================================================================

  // --- onPointerDown: starts the long-press timer on primary button ---
  function onPointerDown(e) {
    if (e.button !== 0) return;
    cancelPress();

    const anchor = findAnchor(e.target);
    if (!anchor) return;

    const href = resolveHref(anchor);
    if (!href) return;

    startX = e.clientX;
    startY = e.clientY;

    pressTimer = setTimeout(() => {
      pressTimer = null;
      triggerPopup(anchor, href, e.clientX, e.clientY);
    }, LONG_PRESS_MS);
  }

  // --- onPointerMove: cancels long-press if the cursor drifts too far ---
  function onPointerMove(e) {
    if (!pressTimer) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (dx * dx + dy * dy > MOVE_THRESHOLD * MOVE_THRESHOLD) {
      cancelPress();
    }
  }

  // --- onPointerUp: cancels long-press if released before threshold ---
  function onPointerUp() {
    if (pressTimer) {
      cancelPress();
    }
    // longPressTriggered stays true so onClickCapture can suppress navigation
  }

  // --- onPointerCancel: cleanup on pointer interruption ---
  function onPointerCancel() {
    cancelPress();
  }

  // --- onClickCapture: handles shift+click, ctrl+click, long-press suppression, and outside-click close ---
  function onClickCapture(e) {
    // Suppress the click event that fires after a successful long-press
    if (longPressTriggered) {
      longPressTriggered = false;
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }

    // Shift+click or Ctrl+click on a link triggers the popup
    if (e.button === 0 && (e.shiftKey || e.ctrlKey)) {
      const anchor = findAnchor(e.target);
      if (anchor) {
        const href = resolveHref(anchor);
        if (href) {
          e.preventDefault();
          e.stopImmediatePropagation();
          triggerPopup(anchor, href, e.clientX, e.clientY);
          return;
        }
      }
    }

    // Close popup on outside click
    if (activePopupHost) {
      const path = e.composedPath();
      if (!path.includes(activePopupHost)) {
        closePopup();
      }
    }
  }

  // --- triggerPopup: validates the URL then opens the popup ---
  function triggerPopup(anchor, href, x, y) {
    longPressTriggered = true;

    if (!isNewsUrl(href)) return;

    const headline = extractHeadline(anchor);
    if (!headline) return;

    showPopup(href, headline, x, y);
  }

  // --- cancelPress: clears the long-press timer ---
  function cancelPress() {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
  }

  // =========================================================================
  // DOM HELPERS
  // =========================================================================

  // --- findAnchor: walks up the DOM to find the nearest <a> element ---
  function findAnchor(el) {
    let node = el;
    for (let i = 0; i < ANCHOR_TRAVERSAL_DEPTH && node && node !== document; i++) {
      if (node.tagName === "A" && node.href) return node;
      node = node.parentElement;
    }
    return null;
  }

  // --- resolveHref: validates and returns the anchor's href, or null ---
  function resolveHref(anchor) {
    const href = anchor.href;
    if (!href) return null;
    if (href.startsWith("javascript:") || href === "#" || href.endsWith("#")) return null;
    try {
      const url = new URL(href, location.href);
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      return url.href;
    } catch (_) {
      return null;
    }
  }

  // --- extractHeadline: gets meaningful text from the anchor ---
  function extractHeadline(anchor) {
    let text = anchor.textContent.trim();

    // Fall back to aria-label or title for image-only links
    if (text.length < 5) {
      text = anchor.getAttribute("aria-label") || anchor.title || text;
    }

    // Collapse whitespace
    text = text.replace(/\s+/g, " ").trim();
    return text || null;
  }

  // =========================================================================
  // NEWS URL FILTERING
  // =========================================================================

  // --- isNewsUrl: two-layer filter — blocks non-news, then checks for article signals ---
  function isNewsUrl(href) {
    let url;
    try {
      url = new URL(href);
    } catch (_) {
      return false;
    }

    const hostname = url.hostname.toLowerCase();

    // Layer 1: block known non-news domains
    if (isBlockedDomain(hostname, url)) return false;

    // Layer 2: require at least one article-like signal
    return hasArticleSignal(url, hostname);
  }

  // --- isBlockedDomain: checks if the hostname matches any blocked domain ---
  function isBlockedDomain(hostname, url) {
    for (const domain of BLOCKED_DOMAINS) {
      if (hostname === domain || hostname.endsWith("." + domain)) return true;
    }
    for (const rule of BLOCKED_SEARCH_PATHS) {
      if (
        (hostname === rule.host || hostname.endsWith("." + rule.host)) &&
        url.pathname.startsWith(rule.path)
      ) {
        return true;
      }
    }
    return false;
  }

  // --- hasArticleSignal: checks if the URL looks like a news article ---
  function hasArticleSignal(url, hostname) {
    const path = url.pathname.toLowerCase();
    const search = url.search.toLowerCase();

    // Signal: path has 3+ segments (e.g. /politics/2024/03/article-title)
    const segments = path.split("/").filter(Boolean);
    if (segments.length >= 3) return true;

    // Signal: path contains a date pattern like /2024/03/ or /20240315/
    if (/\/\d{4}\/\d{2}\//.test(path) || /\/\d{8}\//.test(path)) return true;

    // Signal: path contains article-like keywords
    for (const keyword of ARTICLE_PATH_KEYWORDS) {
      if (path.includes(keyword)) return true;
    }

    // Signal: query string contains article-like params
    for (const key of ARTICLE_QUERY_KEYS) {
      if (search.includes(key + "=")) return true;
    }

    // Signal: hostname contains news-related words
    for (const word of NEWS_HOST_WORDS) {
      if (hostname.includes(word)) return true;
    }

    return false;
  }

  // =========================================================================
  // POPUP UI
  // =========================================================================

  // --- showPopup: creates the Shadow DOM popup and sends the SUMMARIZE request ---
  function showPopup(url, headline, x, y) {
    closePopup();

    const host = document.createElement("div");
    host.id = "nobait-host";
    host.style.cssText = "all:initial;position:fixed;z-index:2147483647;pointer-events:auto;";

    const shadow = host.attachShadow({ mode: "closed" });

    // Inject styles
    const style = document.createElement("style");
    style.textContent = getPopupStyles();
    shadow.appendChild(style);

    // Popup container
    const popup = document.createElement("div");
    popup.className = "nobait-popup";

    // Position near cursor, clamped to viewport
    const popupWidth = 360;
    const popupEstHeight = 240;
    let left = x + 14;
    let top = y + 14;

    if (left + popupWidth > window.innerWidth - 20) {
      left = x - popupWidth - 14;
    }
    if (left < 16) left = 16;
    if (top + popupEstHeight > window.innerHeight - 20) {
      top = y - popupEstHeight - 14;
    }
    if (top < 16) top = 16;

    host.style.left = left + "px";
    host.style.top = top + "px";

    // Header with logo and close button
    const header = document.createElement("div");
    header.className = "nobait-header";

    const logo = document.createElement("span");
    logo.className = "nobait-logo";
    logo.textContent = "NoBait";
    header.appendChild(logo);

    const closeBtn = document.createElement("button");
    closeBtn.className = "nobait-close";
    closeBtn.textContent = "\u00D7";
    closeBtn.title = "Close";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closePopup();
    });
    header.appendChild(closeBtn);

    popup.appendChild(header);

    // Headline preview
    const headlineEl = document.createElement("div");
    headlineEl.className = "nobait-headline";
    headlineEl.textContent = truncate(headline, 120);
    popup.appendChild(headlineEl);

    // Loading spinner
    const spinnerWrap = document.createElement("div");
    spinnerWrap.className = "nobait-body nobait-loading";

    const spinner = document.createElement("div");
    spinner.className = "nobait-spinner";
    spinnerWrap.appendChild(spinner);

    const loadingText = document.createElement("div");
    loadingText.className = "nobait-loading-text";
    loadingText.textContent = "Analyzing article\u2026";
    spinnerWrap.appendChild(loadingText);

    popup.appendChild(spinnerWrap);
    shadow.appendChild(popup);
    document.body.appendChild(host);
    activePopupHost = host;

    // Trigger entrance animation on next frame
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        popup.classList.add("nobait-visible");
      });
    });

    // Request summary from background
    chrome.runtime.sendMessage({ type: "SUMMARIZE", url, headline }, (response) => {
      if (chrome.runtime.lastError) {
        renderError(popup, spinnerWrap, "fetch_failed", "Extension error. Try again.", headline);
        return;
      }
      if (!response) {
        renderError(popup, spinnerWrap, "fetch_failed", "No response from extension.", headline);
        return;
      }
      if (response.ok) {
        renderSummary(popup, spinnerWrap, response.summary);
      } else {
        renderError(popup, spinnerWrap, response.error, response.message, headline);
      }
    });
  }

  // --- renderSummary: replaces spinner with the AI summary text ---
  function renderSummary(popup, spinnerWrap, summary) {
    if (!activePopupHost) return;

    const body = document.createElement("div");
    body.className = "nobait-body";

    const text = document.createElement("div");
    text.className = "nobait-summary";
    text.textContent = summary;
    body.appendChild(text);

    swapContent(popup, spinnerWrap, body);
  }

  // --- renderError: replaces spinner with error message and Google Search fallback ---
  function renderError(popup, spinnerWrap, errorType, message, headline) {
    if (!activePopupHost) return;

    const body = document.createElement("div");
    body.className = "nobait-body nobait-error-body";

    // Error icon
    const icon = document.createElement("div");
    icon.className = "nobait-error-icon";
    if (errorType === "paywall") {
      icon.textContent = "\uD83D\uDD12";
    } else if (errorType === "blocked") {
      icon.textContent = "\uD83D\uDEAB";
    } else {
      icon.textContent = "\u26A0\uFE0F";
    }
    body.appendChild(icon);

    // Error message
    const msg = document.createElement("div");
    msg.className = "nobait-error-msg";
    msg.textContent = message;
    body.appendChild(msg);

    // Google Search fallback button
    const btn = document.createElement("button");
    btn.className = "nobait-fallback-btn";
    btn.textContent = "Search Google";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const query = headline || "";
      window.open("https://www.google.com/search?q=" + encodeURIComponent(query), "_blank");
    });
    body.appendChild(btn);

    swapContent(popup, spinnerWrap, body);
  }

  // --- swapContent: fade-out old content, fade-in new content ---
  function swapContent(popup, oldEl, newEl) {
    oldEl.classList.add("nobait-fade-out");
    setTimeout(() => {
      if (oldEl.parentNode === popup) {
        popup.replaceChild(newEl, oldEl);
        requestAnimationFrame(() => {
          newEl.classList.add("nobait-fade-in");
        });
      }
    }, 150);
  }

  // --- closePopup: removes the popup host from the DOM ---
  function closePopup() {
    if (activePopupHost) {
      activePopupHost.remove();
      activePopupHost = null;
    }
  }

  // --- truncate: shortens a string with an ellipsis ---
  function truncate(str, max) {
    if (str.length <= max) return str;
    return str.substring(0, max - 1) + "\u2026";
  }

  // =========================================================================
  // POPUP STYLES (injected into Shadow DOM)
  // =========================================================================

  // --- getPopupStyles: returns the CSS string for the popup ---
  function getPopupStyles() {
    return `
      * {
        box-sizing: border-box;
      }
      .nobait-popup {
        width: 360px;
        max-width: calc(100vw - 32px);
        background: #ffffff;
        border-radius: 14px;
        box-shadow:
          0 0 0 1px rgba(0, 0, 0, 0.04),
          0 4px 16px rgba(0, 0, 0, 0.12),
          0 12px 40px rgba(0, 0, 0, 0.14);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        overflow: hidden;
        opacity: 0;
        transform: translateY(8px) scale(0.96);
        transition: opacity 0.2s cubic-bezier(0.16, 1, 0.3, 1),
                    transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
        will-change: opacity, transform;
      }
      .nobait-popup.nobait-visible {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
      .nobait-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 12px 8px 16px;
      }
      .nobait-logo {
        font-size: 11px;
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: #6c47ff;
      }
      .nobait-close {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        border: none;
        background: transparent;
        color: #999;
        font-size: 18px;
        line-height: 1;
        border-radius: 6px;
        cursor: pointer;
        transition: background 0.12s ease, color 0.12s ease;
        padding: 0;
      }
      .nobait-close:hover {
        background: #f0f0f0;
        color: #333;
      }
      .nobait-headline {
        padding: 0 16px 12px;
        font-size: 13.5px;
        font-weight: 600;
        color: #1a1a1a;
        line-height: 1.4;
        border-bottom: 1px solid #f0f0f0;
      }
      .nobait-body {
        padding: 16px;
        min-height: 64px;
      }
      .nobait-loading {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 12px;
        padding: 24px 16px;
      }
      .nobait-spinner {
        width: 24px;
        height: 24px;
        border: 2.5px solid #ececec;
        border-top-color: #6c47ff;
        border-radius: 50%;
        animation: nobait-spin 0.7s linear infinite;
      }
      @keyframes nobait-spin {
        to { transform: rotate(360deg); }
      }
      .nobait-loading-text {
        font-size: 12.5px;
        color: #999;
        letter-spacing: 0.01em;
      }
      .nobait-summary {
        font-size: 14px;
        line-height: 1.6;
        color: #1a1a1a;
        width: 100%;
        text-align: left;
        max-height: 200px;
        overflow-y: auto;
        overscroll-behavior: contain;
      }
      .nobait-summary::-webkit-scrollbar {
        width: 6px;
      }
      .nobait-summary::-webkit-scrollbar-track {
        background: transparent;
      }
      .nobait-summary::-webkit-scrollbar-thumb {
        background: #ddd;
        border-radius: 3px;
      }
      .nobait-error-body {
        display: flex;
        flex-direction: column;
        align-items: center;
        text-align: center;
        gap: 8px;
        padding: 20px 16px;
      }
      .nobait-error-icon {
        font-size: 22px;
      }
      .nobait-error-msg {
        font-size: 13px;
        color: #666;
        line-height: 1.45;
      }
      .nobait-fallback-btn {
        margin-top: 6px;
        padding: 8px 18px;
        border: none;
        border-radius: 8px;
        background: #6c47ff;
        color: #fff;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.15s ease, transform 0.1s ease;
      }
      .nobait-fallback-btn:hover {
        background: #5835db;
      }
      .nobait-fallback-btn:active {
        transform: scale(0.97);
      }
      .nobait-fade-out {
        opacity: 0;
        transition: opacity 0.15s ease;
      }
      .nobait-fade-in {
        animation: nobait-fade-in 0.2s ease forwards;
      }
      @keyframes nobait-fade-in {
        from { opacity: 0; transform: translateY(4px); }
        to { opacity: 1; transform: translateY(0); }
      }
    `;
  }
})();
