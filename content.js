// NoBait - Content Script
// Long-click detection and popup UI

(function () {
  "use strict";

  const LONG_PRESS_MS = 800;
  const MOVE_THRESHOLD = 10;

  let pressTimer = null;
  let startX = 0;
  let startY = 0;
  let activePopupHost = null;
  let longPressTriggered = false;
  let pressTarget = null;

  // --- Long-click detection ---

  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("pointermove", onPointerMove, true);
  document.addEventListener("pointerup", onPointerUp, true);
  document.addEventListener("pointercancel", onPointerCancel, true);
  document.addEventListener("pointerleave", onPointerLeave, true);
  document.addEventListener("click", onClickCapture, true);
  document.addEventListener("auxclick", onClickCapture, true);

  function onPointerDown(e) {
    // Only primary button (left click)
    if (e.button !== 0) return;

    cancelPress();

    const anchor = findAnchor(e.target);
    if (!anchor) return;

    const href = anchor.href;
    if (!href || href.startsWith("javascript:") || href === "#" || href.endsWith("#")) return;

    // Filter out non-http links
    try {
      const url = new URL(href, location.href);
      if (url.protocol !== "http:" && url.protocol !== "https:") return;
    } catch (_) {
      return;
    }

    startX = e.clientX;
    startY = e.clientY;
    pressTarget = anchor;

    pressTimer = setTimeout(() => {
      pressTimer = null;
      longPressTriggered = true;

      const headline = extractHeadline(anchor);
      if (headline) {
        showPopup(href, headline, e.clientX, e.clientY);
      }
    }, LONG_PRESS_MS);
  }

  function onPointerMove(e) {
    if (!pressTimer) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (dx * dx + dy * dy > MOVE_THRESHOLD * MOVE_THRESHOLD) {
      cancelPress();
    }
  }

  function onPointerUp(e) {
    if (pressTimer) {
      // Released before the timer fired — normal click, let it through
      cancelPress();
    }
    // If longPressTriggered is true, we leave it set so onClickCapture blocks navigation
  }

  function onPointerCancel() {
    cancelPress();
  }

  function onPointerLeave(e) {
    // Only cancel if the pointer left the document (not just an element)
    if (e.target === document || e.target === document.documentElement) {
      cancelPress();
    }
  }

  function onClickCapture(e) {
    // After a long-press, suppress the click that the browser fires on release
    // This prevents navigation to the link
    if (longPressTriggered) {
      longPressTriggered = false;
      pressTarget = null;
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }

    // Close popup on outside click
    if (activePopupHost) {
      const path = e.composedPath();
      if (!path.includes(activePopupHost)) {
        closePopup();
      }
    }
  }

  function cancelPress() {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
    pressTarget = null;
  }

  function findAnchor(el) {
    let node = el;
    // Traverse up to 10 levels to handle deeply nested DOM (Google News, etc.)
    for (let i = 0; i < 10 && node && node !== document; i++) {
      if (node.tagName === "A" && node.href) return node;
      node = node.parentElement;
    }
    return null;
  }

  function extractHeadline(anchor) {
    // Try to get meaningful text from the anchor or nearby heading
    let text = anchor.textContent.trim();

    // If the link has very little text (e.g. just an image), try aria-label or title
    if (text.length < 5) {
      text = anchor.getAttribute("aria-label") || anchor.title || text;
    }

    // Collapse whitespace
    text = text.replace(/\s+/g, " ").trim();
    return text || null;
  }

  // --- Popup UI ---

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

    // Header
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

    // Loading state
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

    // Trigger entrance animation
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        popup.classList.add("nobait-visible");
      });
    });

    // Request summary from background
    chrome.runtime.sendMessage(
      { type: "SUMMARIZE", url, headline },
      (response) => {
        if (chrome.runtime.lastError) {
          renderError(popup, spinnerWrap, "fetch_failed", "Extension error. Try again.");
          return;
        }
        if (!response) {
          renderError(popup, spinnerWrap, "fetch_failed", "No response from extension.");
          return;
        }
        if (response.ok) {
          renderSummary(popup, spinnerWrap, response.summary);
        } else {
          renderError(popup, spinnerWrap, response.error, response.message);
        }
      }
    );
  }

  function renderSummary(popup, spinnerWrap, summary) {
    if (!activePopupHost) return;

    const body = document.createElement("div");
    body.className = "nobait-body";

    const text = document.createElement("div");
    text.className = "nobait-summary";
    text.textContent = summary;
    body.appendChild(text);

    spinnerWrap.classList.add("nobait-fade-out");
    setTimeout(() => {
      if (spinnerWrap.parentNode === popup) {
        popup.replaceChild(body, spinnerWrap);
        requestAnimationFrame(() => {
          body.classList.add("nobait-fade-in");
        });
      }
    }, 150);
  }

  function renderError(popup, spinnerWrap, errorType, message) {
    if (!activePopupHost) return;

    const body = document.createElement("div");
    body.className = "nobait-body nobait-error-body";

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

    const msg = document.createElement("div");
    msg.className = "nobait-error-msg";
    msg.textContent = message;
    body.appendChild(msg);

    const btn = document.createElement("button");
    btn.className = "nobait-fallback-btn";
    btn.textContent = "Search for answer";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const headlineEl = popup.querySelector(".nobait-headline");
      const query = headlineEl ? headlineEl.textContent : "";
      window.open("https://www.google.com/search?q=" + encodeURIComponent(query), "_blank");
    });
    body.appendChild(btn);

    spinnerWrap.classList.add("nobait-fade-out");
    setTimeout(() => {
      if (spinnerWrap.parentNode === popup) {
        popup.replaceChild(body, spinnerWrap);
        requestAnimationFrame(() => {
          body.classList.add("nobait-fade-in");
        });
      }
    }, 150);
  }

  function closePopup() {
    if (activePopupHost) {
      const host = activePopupHost;
      const shadow = host.shadowRoot;
      // If shadow is closed, we can't animate — just remove
      activePopupHost = null;
      host.remove();
    }
  }

  function truncate(str, max) {
    if (str.length <= max) return str;
    return str.substring(0, max - 1) + "\u2026";
  }

  // --- Inline styles for Shadow DOM ---

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
