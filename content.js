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
  // Set to true the moment a popup is shown so the next click is swallowed.
  // Prevents the mouseup-triggered click from navigating away after a hold.
  let suppressNextClick = false;

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

  // anchorEl is the <a> that was long-held, used by the Copy Debug handler.
  function setTooltipResult(resolvedUrl, debugInfo, anchorEl) {
    if (!tooltipEl) return;

    const same = debugInfo.originalUrl === resolvedUrl;
    const methodHint = debugInfo.method && debugInfo.method !== "none"
      ? ` (via ${debugInfo.method})`
      : "";
    const label = same ? "Final URL (no redirect)" : `Resolved URL${methodHint}`;

    tooltipEl.innerHTML =
      `<div id="nobait-tooltip-label">${label}</div>` +
      `<div id="nobait-tooltip-url">${escapeHtml(resolvedUrl)}</div>` +
      `<div id="nobait-tooltip-buttons">` +
        `<button id="nobait-tooltip-copy" type="button">Copy URL</button>` +
        `<button id="nobait-tooltip-copy-debug" type="button">Copy Debug</button>` +
      `</div>` +
      `<div id="nobait-tooltip-debug">${escapeHtml(formatDebugInfo(debugInfo))}</div>`;

    const copyBtn = tooltipEl.querySelector("#nobait-tooltip-copy");
    copyBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    copyBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      copyToClipboard(resolvedUrl, copyBtn, "Copy URL");
    });

    const debugBtn = tooltipEl.querySelector("#nobait-tooltip-copy-debug");
    debugBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    debugBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const debugText = buildFullDebugText(debugInfo, anchorEl);
      copyToClipboard(debugText, debugBtn, "Copy Debug");
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
    // Safety reset — if tooltip is dismissed before a click arrives, don't
    // suppress a future unrelated click.
    suppressNextClick = false;
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

  // Builds the full debug dump for the Copy Debug button.
  // Includes anchor text, publisher heuristic, all debug log entries, and error info.
  function buildFullDebugText(info, anchorEl) {
    // Best-effort: get visible article title from the anchor's text content
    let articleTitle = "unknown";
    if (anchorEl) {
      const text = anchorEl.textContent.trim();
      if (text) articleTitle = text;
    }

    // Best-effort: find publisher name from common data attributes or sibling text near the anchor
    let publisher = "unknown";
    if (anchorEl) {
      const candidates = [
        anchorEl.closest("[data-source]"),
        anchorEl.closest("[data-publisher]"),
        anchorEl.closest("[data-site-name]"),
        anchorEl.querySelector(".source, .publisher, [class*='source'], [class*='publisher']"),
        anchorEl.parentElement
          ? anchorEl.parentElement.querySelector(".source, .publisher, [class*='source'], [class*='publisher']")
          : null,
      ].filter(Boolean);
      for (const el of candidates) {
        const val =
          el.getAttribute("data-source") ||
          el.getAttribute("data-publisher") ||
          el.getAttribute("data-site-name") ||
          el.textContent.trim();
        if (val) {
          publisher = val.slice(0, 120); // cap length
          break;
        }
      }
    }

    const lines = [
      `requestId         : ${info.requestId || "unknown"}`,
      `articleTitle      : ${articleTitle}`,
      `publisher         : ${publisher}`,
      `originalUrl       : ${info.originalUrl || "unknown"}`,
      `resolvedUrl       : ${info.resolvedUrl || "unknown"}`,
      `resolverPath      : ${info.method || "unknown"}`,
      `timestamp         : ${new Date().toISOString()}`,
      `---`,
      `--- In-popup debug log ---`,
      debugLog.join("\n"),
      `---`,
      `error             : ${info.error || "none"}`,
      `errorName         : ${info.errorName || "none"}`,
      `errorStack        : ${info.errorStack || "none"}`,
      `status            : ${info.status !== undefined ? info.status : "unknown"}`,
      `redirected        : ${info.redirected !== undefined ? info.redirected : "unknown"}`,
      `success           : ${info.success !== undefined ? info.success : "unknown"}`,
      `pageUrl           : ${window.location.href}`,
    ];
    return lines.join("\n");
  }

  async function copyToClipboard(text, btnEl, resetLabel = "Copy URL") {
    try {
      await navigator.clipboard.writeText(text);
      log("INFO", `Copied to clipboard (${resetLabel}), length=${text.length}`);
      if (btnEl) {
        btnEl.textContent = "Copied!";
        btnEl.classList.add("nobait-copied");
        setTimeout(() => {
          if (btnEl) {
            btnEl.textContent = resetLabel;
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
  }

  function onKeyDown(e) {
    if (e.key === "Escape") {
      log("INFO", "Escape pressed — dismissing tooltip");
      cancelHold();
      removeTooltip();
    }
  }

  // Capture-phase click handler that swallows the click fired on mouseup
  // after a long-hold popup appears. Clears the flag immediately so only
  // the one post-hold click is affected; short clicks pass through normally.
  function onClickCapture(e) {
    if (!suppressNextClick) return;
    suppressNextClick = false;
    e.preventDefault();
    e.stopImmediatePropagation();
    log("INFO", "Suppressed post-popup click on anchor (long-hold popup was active)");
  }

  // ── Resolve and display ────────────────────────────────────────────

  function resolveAndShow(url, x, y) {
    const reqId = `req-${++requestCounter}-${Date.now()}`;
    // Capture anchor reference now — activeAnchor may be cleared by the time
    // the async response arrives.
    const capturedAnchor = activeAnchor;

    log("INFO", `Sending resolve request | requestId=${reqId} | url=${url}`);

    const tip = createTooltip(x, y);
    if (!tip) {
      log("ERROR", "Failed to create tooltip element");
      return;
    }

    // Popup is now visible — arm the click suppressor so the mouseup-triggered
    // click on the underlying anchor doesn't navigate the page away.
    suppressNextClick = true;
    log("INFO", "suppressNextClick armed — next page click will be swallowed");

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
          setTooltipResult(
            response.resolvedUrl,
            {
              requestId: reqId,
              originalUrl: url,
              resolvedUrl: response.resolvedUrl,
              status: response.status,
              redirected: response.redirected,
              method: response.method,
              success: true,
            },
            capturedAnchor
          );
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
  // Capture-phase click suppressor — must run before anchor's own click handler
  document.addEventListener("click", onClickCapture, true);

  log("INFO", `NoBait v2 content script loaded on ${window.location.href}`);
})();
