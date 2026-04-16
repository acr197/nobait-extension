// content.js — NoBait v2 content script
// Listens for mousedown-hold on anchors, requests redirect resolution,
// and renders a tooltip with the resolved URL.

(function () {
  "use strict";

  // ── Constants ──────────────────────────────────────────────────────
  const HOLD_DELAY_MS = 500;
  const MOVE_THRESHOLD_PX = 5;
  const TOOLTIP_OFFSET_X = 12;
  const TOOLTIP_OFFSET_Y = 16;

  // ── State ──────────────────────────────────────────────────────────
  let holdTimer = null;
  let startX = 0;
  let startY = 0;
  let tooltipEl = null;
  let activeAnchor = null;
  let requestCounter = 0;
  let debugLog = [];

  // ── Debug helpers ──────────────────────────────────────────────────
  function log(level, ...args) {
    const ts = new Date().toISOString();
    const msg = args
      .map((a) => (typeof a === "object" ? JSON.stringify(a, null, 2) : String(a)))
      .join(" ");
    const entry = `[${ts}] [NoBait CS] [${level}] ${msg}`;
    debugLog.push(entry);
    if (level === "ERROR") {
      console.error(entry);
    } else if (level === "WARN") {
      console.warn(entry);
    } else {
      console.log(entry);
    }
  }

  function getDebugDump() {
    return debugLog.join("\n");
  }

  // ── Tooltip management ─────────────────────────────────────────────

  function createTooltip(x, y) {
    removeTooltip();

    tooltipEl = document.createElement("div");
    tooltipEl.id = "nobait-tooltip";
    // Position near cursor
    positionTooltip(x, y);

    document.body.appendChild(tooltipEl);

    // Trigger opacity transition
    requestAnimationFrame(() => {
      if (tooltipEl) tooltipEl.classList.add("nobait-visible");
    });

    // Dismiss on mouseleave from the tooltip itself
    tooltipEl.addEventListener("mouseleave", () => {
      log("INFO", "Tooltip mouseleave — dismissing");
      removeTooltip();
    });

    log("INFO", `Tooltip created at (${x}, ${y})`);
    return tooltipEl;
  }

  function positionTooltip(x, y) {
    if (!tooltipEl) return;

    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = x + TOOLTIP_OFFSET_X;
    let top = y + TOOLTIP_OFFSET_Y;

    // After rendering, adjust if the tooltip overflows the viewport.
    // We set it first, then correct after a frame so we can measure.
    tooltipEl.style.left = left + "px";
    tooltipEl.style.top = top + "px";

    requestAnimationFrame(() => {
      if (!tooltipEl) return;
      const rect = tooltipEl.getBoundingClientRect();
      if (rect.right > vw - 8) {
        left = vw - rect.width - 8;
      }
      if (rect.bottom > vh - 8) {
        top = y - rect.height - 8;
      }
      if (left < 8) left = 8;
      if (top < 8) top = 8;
      tooltipEl.style.left = left + "px";
      tooltipEl.style.top = top + "px";
    });
  }

  function setTooltipLoading(originalUrl) {
    if (!tooltipEl) return;
    tooltipEl.innerHTML =
      `<div id="nobait-tooltip-label">Resolving redirect</div>` +
      `<div id="nobait-tooltip-loading">Following redirects for<br><strong>${escapeHtml(originalUrl)}</strong></div>`;
  }

  function setTooltipResult(resolvedUrl, debugInfo) {
    if (!tooltipEl) return;

    const same = debugInfo.originalUrl === resolvedUrl;
    const methodHint = debugInfo.method && debugInfo.method !== "none"
      ? ` (via ${debugInfo.method})`
      : "";
    const label = same ? "Final URL (no redirect)" : `Resolved URL${methodHint}`;

    tooltipEl.innerHTML =
      `<div id="nobait-tooltip-label">${label}</div>` +
      `<div id="nobait-tooltip-url">${escapeHtml(resolvedUrl)}</div>` +
      `<button id="nobait-tooltip-copy" type="button">Copy URL</button>` +
      `<div id="nobait-tooltip-debug">${escapeHtml(formatDebugInfo(debugInfo))}</div>`;

    const copyBtn = tooltipEl.querySelector("#nobait-tooltip-copy");
    copyBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    copyBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      copyToClipboard(resolvedUrl, copyBtn);
    });

    // Re-check position now that content changed size
    const rect = tooltipEl.getBoundingClientRect();
    positionTooltip(rect.left, rect.top - TOOLTIP_OFFSET_Y);
  }

  function setTooltipError(errorMsg, debugInfo) {
    if (!tooltipEl) return;
    tooltipEl.innerHTML =
      `<div id="nobait-tooltip-label">Could not resolve URL</div>` +
      `<div id="nobait-tooltip-error">${escapeHtml(errorMsg)}</div>` +
      `<div id="nobait-tooltip-debug">${escapeHtml(formatDebugInfo(debugInfo))}</div>`;
  }

  function removeTooltip() {
    if (tooltipEl) {
      tooltipEl.remove();
      tooltipEl = null;
      log("INFO", "Tooltip removed");
    }
    activeAnchor = null;
  }

  // ── Utility ────────────────────────────────────────────────────────

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function formatDebugInfo(info) {
    const lines = [
      `--- NoBait v2 Debug ---`,
      `requestId   : ${info.requestId || "N/A"}`,
      `originalUrl : ${info.originalUrl || "N/A"}`,
      `resolvedUrl : ${info.resolvedUrl || "N/A"}`,
      `status      : ${info.status || "N/A"}`,
      `redirected  : ${info.redirected !== undefined ? info.redirected : "N/A"}`,
      `method      : ${info.method || "N/A"}`,
      `success     : ${info.success !== undefined ? info.success : "N/A"}`,
      `error       : ${info.error || "none"}`,
      `errorName   : ${info.errorName || "none"}`,
      `errorStack  : ${info.errorStack || "none"}`,
      `timestamp   : ${new Date().toISOString()}`,
      `pageUrl     : ${window.location.href}`,
      `---`,
      `Copy this block and paste into Claude Code to debug.`,
    ];
    return lines.join("\n");
  }

  async function copyToClipboard(text, btnEl) {
    try {
      await navigator.clipboard.writeText(text);
      log("INFO", `Copied to clipboard: ${text}`);
      if (btnEl) {
        btnEl.textContent = "Copied!";
        btnEl.classList.add("nobait-copied");
        setTimeout(() => {
          if (btnEl) {
            btnEl.textContent = "Copy URL";
            btnEl.classList.remove("nobait-copied");
          }
        }, 1500);
      }
    } catch (err) {
      log("ERROR", `Clipboard write failed: ${err.message}`);
      // Fallback: select the URL text so user can Ctrl+C
      const urlEl = document.querySelector("#nobait-tooltip-url");
      if (urlEl) {
        const range = document.createRange();
        range.selectNodeContents(urlEl);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
  }

  function findClosestAnchor(el) {
    while (el && el !== document.body) {
      if (el.tagName === "A" && el.href) return el;
      el = el.parentElement;
    }
    return null;
  }

  // ── Core event handlers ────────────────────────────────────────────

  function cancelHold() {
    if (holdTimer !== null) {
      clearTimeout(holdTimer);
      holdTimer = null;
      log("INFO", "Hold cancelled");
    }
  }

  function onMouseDown(e) {
    // Only respond to primary (left) button
    if (e.button !== 0) return;

    const anchor = findClosestAnchor(e.target);
    if (!anchor) return;

    const href = anchor.href;
    if (!href || href.startsWith("javascript:") || href.startsWith("#")) {
      log("INFO", `Skipping non-navigable href: ${href}`);
      return;
    }

    startX = e.clientX;
    startY = e.clientY;
    activeAnchor = anchor;

    log("INFO", `Mousedown on anchor: ${href} at (${startX}, ${startY})`);

    cancelHold();

    holdTimer = setTimeout(() => {
      holdTimer = null;
      log("INFO", `Hold threshold reached (${HOLD_DELAY_MS}ms) — resolving: ${href}`);
      resolveAndShow(href, startX, startY);
    }, HOLD_DELAY_MS);
  }

  function onMouseMove(e) {
    if (holdTimer === null) return;

    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist > MOVE_THRESHOLD_PX) {
      log("INFO", `Mouse moved ${dist.toFixed(1)}px (>${MOVE_THRESHOLD_PX}px) — cancelling hold`);
      cancelHold();
    }
  }

  function onMouseUp() {
    cancelHold();
    // Do NOT remove tooltip on mouseup from the anchor —
    // only dismiss if the user mouses away from the tooltip or presses Escape.
    // However, if no tooltip is showing, nothing to do.
  }

  function onKeyDown(e) {
    if (e.key === "Escape") {
      log("INFO", "Escape pressed — dismissing tooltip");
      cancelHold();
      removeTooltip();
    }
  }

  // ── Resolve and display ────────────────────────────────────────────

  function resolveAndShow(url, x, y) {
    const reqId = `req-${++requestCounter}-${Date.now()}`;
    log("INFO", `Sending resolve request | requestId=${reqId} | url=${url}`);

    const tip = createTooltip(x, y);
    if (!tip) {
      log("ERROR", "Failed to create tooltip element");
      return;
    }
    setTooltipLoading(url);

    chrome.runtime.sendMessage(
      { type: "resolve-url", url: url, requestId: reqId },
      (response) => {
        if (chrome.runtime.lastError) {
          const errMsg = chrome.runtime.lastError.message;
          log(
            "ERROR",
            `chrome.runtime.sendMessage failed | requestId=${reqId}\n` +
              `  lastError: ${errMsg}\n` +
              `  This usually means the service worker was inactive or the extension was reloaded.\n` +
              `  Possible fix: reload the extension from chrome://extensions, then refresh this page.`
          );
          setTooltipError(`Extension communication error: ${errMsg}`, {
            requestId: reqId,
            originalUrl: url,
            error: errMsg,
            errorName: "RuntimeLastError",
            errorStack: new Error().stack,
            success: false,
          });
          return;
        }

        if (!response) {
          log(
            "ERROR",
            `No response received from background | requestId=${reqId}\n` +
              `  The service worker may not have returned true from onMessage.\n` +
              `  Check that background.js is loaded and the listener returns true for async.`
          );
          setTooltipError("No response from background worker", {
            requestId: reqId,
            originalUrl: url,
            error: "Response was null/undefined",
            success: false,
          });
          return;
        }

        log("INFO", `Response received | requestId=${reqId} | success=${response.success}`);

        if (response.success) {
          setTooltipResult(response.resolvedUrl, {
            requestId: reqId,
            originalUrl: url,
            resolvedUrl: response.resolvedUrl,
            status: response.status,
            redirected: response.redirected,
            method: response.method,
            success: true,
          });
        } else {
          log("ERROR", `Resolution failed | requestId=${reqId} | error=${response.error}`);
          setTooltipError(response.error || "Unknown error", {
            requestId: reqId,
            originalUrl: url,
            error: response.error,
            errorName: response.errorName,
            errorStack: response.errorStack,
            success: false,
          });
        }
      }
    );
  }

  // ── Register listeners ─────────────────────────────────────────────
  document.addEventListener("mousedown", onMouseDown, true);
  document.addEventListener("mousemove", onMouseMove, true);
  document.addEventListener("mouseup", onMouseUp, true);
  document.addEventListener("keydown", onKeyDown, true);

  log("INFO", `NoBait v2 content script loaded on ${window.location.href}`);
})();
