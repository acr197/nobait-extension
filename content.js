// NoBait - Content Script
// Long-click detection and popup UI

(function () {
  "use strict";

  const LONG_PRESS_MS = 500;
  const MOVE_THRESHOLD = 10;

  let pressTimer = null;
  let startX = 0;
  let startY = 0;
  let activePopupHost = null;

  // --- Long-click detection ---

  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("pointermove", onPointerMove, true);
  document.addEventListener("pointerup", onPointerUp, true);
  document.addEventListener("click", onDocumentClick, true);

  function onPointerDown(e) {
    // Only respond to primary button (left click)
    if (e.button !== 0) return;

    const anchor = findAnchor(e.target);
    if (!anchor) return;

    const href = anchor.href;
    if (!href || href.startsWith("javascript:") || href.startsWith("#")) return;

    startX = e.clientX;
    startY = e.clientY;

    pressTimer = setTimeout(() => {
      pressTimer = null;
      const headline = anchor.textContent.trim();
      if (headline) {
        e.preventDefault();
        e.stopPropagation();
        showPopup(href, headline, e.clientX, e.clientY);
      }
    }, LONG_PRESS_MS);
  }

  function onPointerMove(e) {
    if (!pressTimer) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (dx * dx + dy * dy > MOVE_THRESHOLD * MOVE_THRESHOLD) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
  }

  function onPointerUp(e) {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
  }

  function onDocumentClick(e) {
    if (!activePopupHost) return;

    // Check if click is inside the popup (shadow DOM)
    const path = e.composedPath();
    if (path.includes(activePopupHost)) return;

    closePopup();
  }

  function findAnchor(el) {
    let node = el;
    for (let i = 0; i < 5 && node && node !== document; i++) {
      if (node.tagName === "A") return node;
      node = node.parentElement;
    }
    return null;
  }

  // --- Popup UI ---

  function showPopup(url, headline, x, y) {
    closePopup();

    const host = document.createElement("div");
    host.id = "nobait-host";
    host.style.cssText = "all:initial;position:fixed;z-index:2147483647;";

    const shadow = host.attachShadow({ mode: "closed" });

    // Inject styles
    const style = document.createElement("style");
    style.textContent = getPopupStyles();
    shadow.appendChild(style);

    // Popup container
    const popup = document.createElement("div");
    popup.className = "nobait-popup";

    // Position near cursor, clamped to viewport
    const popupWidth = 340;
    const popupMaxHeight = 260;
    let left = x + 12;
    let top = y + 12;

    if (left + popupWidth > window.innerWidth - 16) {
      left = x - popupWidth - 12;
    }
    if (left < 16) left = 16;
    if (top + popupMaxHeight > window.innerHeight - 16) {
      top = y - popupMaxHeight - 12;
    }
    if (top < 16) top = 16;

    host.style.left = left + "px";
    host.style.top = top + "px";

    // Header
    const header = document.createElement("div");
    header.className = "nobait-header";
    header.textContent = "NoBait";
    popup.appendChild(header);

    // Headline preview
    const headlineEl = document.createElement("div");
    headlineEl.className = "nobait-headline";
    headlineEl.textContent = truncate(headline, 100);
    popup.appendChild(headlineEl);

    // Spinner
    const spinnerWrap = document.createElement("div");
    spinnerWrap.className = "nobait-body";

    const spinner = document.createElement("div");
    spinner.className = "nobait-spinner";
    spinnerWrap.appendChild(spinner);

    const loadingText = document.createElement("div");
    loadingText.className = "nobait-loading-text";
    loadingText.textContent = "Analyzing article...";
    spinnerWrap.appendChild(loadingText);

    popup.appendChild(spinnerWrap);
    shadow.appendChild(popup);
    document.body.appendChild(host);
    activePopupHost = host;

    // Trigger animation
    requestAnimationFrame(() => {
      popup.classList.add("nobait-visible");
    });

    // Request summary from background
    chrome.runtime.sendMessage(
      { type: "SUMMARIZE", url, headline },
      (response) => {
        if (chrome.runtime.lastError) {
          renderError(shadow, popup, spinnerWrap, "fetch_failed", "Extension error. Try again.");
          return;
        }
        if (!response) {
          renderError(shadow, popup, spinnerWrap, "fetch_failed", "No response from extension.");
          return;
        }
        if (response.ok) {
          renderSummary(shadow, popup, spinnerWrap, response.summary);
        } else {
          renderError(shadow, popup, spinnerWrap, response.error, response.message);
        }
      }
    );
  }

  function renderSummary(shadow, popup, spinnerWrap, summary) {
    if (!activePopupHost) return;

    const body = document.createElement("div");
    body.className = "nobait-body";

    const text = document.createElement("div");
    text.className = "nobait-summary";
    text.textContent = summary;
    body.appendChild(text);

    popup.replaceChild(body, spinnerWrap);
  }

  function renderError(shadow, popup, spinnerWrap, errorType, message) {
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
    btn.textContent = "Find similar answers";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const headlineEl = popup.querySelector(".nobait-headline");
      const query = headlineEl ? headlineEl.textContent : "";
      window.open("https://www.google.com/search?q=" + encodeURIComponent(query), "_blank");
    });
    body.appendChild(btn);

    popup.replaceChild(body, spinnerWrap);
  }

  function closePopup() {
    if (activePopupHost) {
      activePopupHost.remove();
      activePopupHost = null;
    }
  }

  function truncate(str, max) {
    if (str.length <= max) return str;
    return str.substring(0, max - 1) + "\u2026";
  }

  // --- Inline styles for Shadow DOM ---

  function getPopupStyles() {
    return `
      .nobait-popup {
        width: 340px;
        background: #fff;
        border-radius: 12px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.08);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        overflow: hidden;
        opacity: 0;
        transform: translateY(6px) scale(0.97);
        transition: opacity 0.15s ease, transform 0.15s ease;
      }
      .nobait-popup.nobait-visible {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
      .nobait-header {
        padding: 10px 16px 6px;
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: #6c47ff;
      }
      .nobait-headline {
        padding: 0 16px 10px;
        font-size: 13px;
        font-weight: 600;
        color: #1a1a1a;
        line-height: 1.35;
        border-bottom: 1px solid #f0f0f0;
      }
      .nobait-body {
        padding: 16px;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 10px;
        min-height: 60px;
      }
      .nobait-spinner {
        width: 22px;
        height: 22px;
        border: 2.5px solid #e8e8e8;
        border-top-color: #6c47ff;
        border-radius: 50%;
        animation: nobait-spin 0.6s linear infinite;
      }
      @keyframes nobait-spin {
        to { transform: rotate(360deg); }
      }
      .nobait-loading-text {
        font-size: 12px;
        color: #999;
      }
      .nobait-summary {
        font-size: 14px;
        line-height: 1.55;
        color: #222;
        width: 100%;
        text-align: left;
      }
      .nobait-error-body {
        align-items: center;
        text-align: center;
      }
      .nobait-error-icon {
        font-size: 20px;
      }
      .nobait-error-msg {
        font-size: 13px;
        color: #666;
        line-height: 1.4;
      }
      .nobait-fallback-btn {
        margin-top: 4px;
        padding: 8px 16px;
        border: none;
        border-radius: 8px;
        background: #6c47ff;
        color: #fff;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.15s ease;
      }
      .nobait-fallback-btn:hover {
        background: #5835db;
      }
    `;
  }
})();
