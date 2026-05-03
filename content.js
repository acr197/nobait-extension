// content.js — NoBait content script
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
  let activeRequestId = null;
  let requestCounter = 0;
  let debugLog = [];
  // Cached fallback settings — populated async on init and updated when the
  // popup writes new values. Used by buildActionRowHtml() to render buttons.
  let cachedSettings = null;
  // Set to true the moment a popup is shown so the next click is swallowed.
  // Prevents the mouseup-triggered click from navigating away after a hold.
  let suppressNextClick = false;
  // Per-request telemetry assembled as the pipeline progresses; surfaced
  // verbatim in the Copy Debug payload.
  let activeMeta = null;
  let extensionVersion = "unknown";
  try {
    const m = chrome.runtime.getManifest();
    if (m && m.version) extensionVersion = m.version;
  } catch (_) {}

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

  // anchorEl is the <a> that was long-held, used by the Copy Debug handler
  // and by the block-action buttons (Try Archive etc.) once block UI shows.
  function setTooltipResult(resolvedUrl, debugInfo, anchorEl) {
    if (!tooltipEl) return;

    const same = debugInfo.originalUrl === resolvedUrl;
    const methodHint = debugInfo.method && debugInfo.method !== "none"
      ? ` (via ${debugInfo.method})`
      : "";
    const urlLabel = same ? "Final URL (no redirect)" : `Resolved URL${methodHint}`;

    // Answer-state action row: settings-driven fallback buttons + always-shown
    // actions (More context, Google, DDG, Debug). Built dynamically from
    // cached popup settings so users control which buttons appear.
    tooltipEl.innerHTML =
      `<div id="nobait-tooltip-answer-area">` +
        `<div id="nobait-tooltip-answer-label">The answer</div>` +
        `<div id="nobait-tooltip-answer" class="nobait-answer-thinking">Reading the article</div>` +
        `<div id="nobait-tooltip-source-note" class="nobait-extras-hidden"></div>` +
        buildActionRowHtml("answer") +
        `<div id="nobait-tooltip-block-result"></div>` +
      `</div>` +
      `<div id="nobait-tooltip-extras" class="nobait-extras-hidden">` +
        `<div id="nobait-tooltip-separator"></div>` +
        `<div id="nobait-tooltip-label">${urlLabel}</div>` +
        `<div id="nobait-tooltip-url">${escapeHtml(resolvedUrl)}</div>` +
        `<div id="nobait-tooltip-buttons">` +
          `<button id="nobait-tooltip-copy" type="button">Copy URL</button>` +
          `<button id="nobait-tooltip-copy-debug" type="button">Copy Debug</button>` +
        `</div>` +
        `<div id="nobait-tooltip-debug">${escapeHtml(formatDebugInfo(debugInfo))}</div>` +
      `</div>`;

    wireMoreContextButton(resolvedUrl);
    wireDebugToggleButton();
    // Wire the alt-source / archive / google / ddg buttons with the article
    // context the user already has loaded (headline + URLs + date).
    wireBlockActionButtons({
      requestId: debugInfo.requestId,
      headline: (activeMeta && activeMeta.headline) || "",
      articleTitle: activeMeta && activeMeta.articleTitle,
      originalUrl: debugInfo.originalUrl,
      resolvedUrl,
      articleDate: activeMeta && activeMeta.articleDate,
      block: { kind: "answer-state" },
    });

    // Stash references the block-action buttons need if a paywall arrives later.
    if (activeMeta && activeMeta.requestId === debugInfo.requestId) {
      activeMeta.originalUrl = debugInfo.originalUrl;
      activeMeta.resolvedUrl = resolvedUrl;
      activeMeta.debugInfo = debugInfo;
      activeMeta.anchorEl = anchorEl;
    }

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

  // Swaps the "Reading the article" placeholder with the model's answer
  // (or an error blurb) once the background pipeline completes. Enables
  // the "More context" button only when a real answer landed. If the
  // answer came from a fallback source (cookies, JSON-LD, alt source,
  // archive, etc.), shows a small attribution note above the action row.
  function updateTooltipAnswer(answer, error, source) {
    if (!tooltipEl) return;
    const answerEl = tooltipEl.querySelector("#nobait-tooltip-answer");
    if (!answerEl) return;
    answerEl.classList.remove("nobait-answer-thinking");
    let enableMore = false;
    if (error) {
      answerEl.classList.add("nobait-answer-error");
      answerEl.textContent = `Could not summarize (${error})`;
    } else if (answer) {
      answerEl.textContent = answer;
      enableMore = true;
      if (source && source.method === "altSource") {
        const labelEl = tooltipEl.querySelector("#nobait-tooltip-answer-label");
        if (labelEl) labelEl.textContent = "Summary from alternative source";
      }
    } else {
      answerEl.classList.add("nobait-answer-error");
      answerEl.textContent = "No answer returned";
    }
    if (enableMore) enableMoreContextButton();
    if (source) showSourceAttribution(source);
    // Reflow in case the new content changed the tooltip's height
    const rect = tooltipEl.getBoundingClientRect();
    positionTooltip(rect.left, rect.top - TOOLTIP_OFFSET_Y);
  }

  // Renders the "Read with cookies" / "From NPR" / "Wayback snapshot 2026-04-20"
  // note between the answer text and the action row. Source describes WHERE
  // the answer came from when it wasn't the original publisher's primary HTML.
  function showSourceAttribution(source) {
    if (!tooltipEl) return;
    const note = tooltipEl.querySelector("#nobait-tooltip-source-note");
    if (!note) return;

    const method = source.method || "";
    let html = "";
    if (method === "jsonLd") {
      html = `<em>Read from the page's embedded article body.</em>`;
    } else if (method === "metaDesc") {
      html = `<em>Summary built from page metadata (no full body available).</em>`;
    } else if (method === "cookies") {
      html = `<em>Fetched with your browser cookies.</em>`;
    } else if (method === "amp") {
      const url = source.url ? ` (<a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">AMP version</a>)` : "";
      html = `<em>Read from AMP version${url}.</em>`;
    } else if (method === "twelveFt") {
      html = `<em>Routed via 12ft.io bypass proxy.</em>`;
    } else if (method === "altSource") {
      const pub = escapeHtml(source.publisher || source.name || "alternative publisher");
      const link = source.url
        ? ` · <a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">Open article</a>`
        : "";
      html = `${pub}${link}`;
    } else if (method === "archive") {
      const date = source.snapshotDate ? ` (${escapeHtml(source.snapshotDate)})` : "";
      const link = source.url
        ? ` · <a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">Open snapshot</a>`
        : "";
      html = `<strong>From Wayback Machine snapshot${date}</strong>${link}`;
    } else {
      return;
    }
    note.innerHTML = html;
    note.classList.remove("nobait-extras-hidden");
  }

  // Wires the More context button. Click sends an expand-answer message
  // with the cached resolvedUrl + the current answer text. The button is
  // strictly one-shot per long-press: on click it goes loading → done (or
  // failed), and stays disabled either way.
  function wireMoreContextButton(resolvedUrl) {
    if (!tooltipEl) return;
    const btn = tooltipEl.querySelector("#nobait-tooltip-more-context");
    if (!btn) return;

    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (btn.disabled) return;

      const answerEl = tooltipEl && tooltipEl.querySelector("#nobait-tooltip-answer");
      const originalAnswer = answerEl ? answerEl.textContent.trim() : "";
      const headline = (activeMeta && activeMeta.headline) || "";
      const requestId = activeMeta && activeMeta.requestId;

      if (!originalAnswer || !requestId) {
        log("WARN", "More context clicked but no answer/requestId available — ignoring");
        return;
      }

      btn.disabled = true;
      btn.classList.add("nobait-action-pending");
      btn.textContent = "Expanding…";
      if (answerEl) answerEl.classList.add("nobait-answer-expanding");

      log(
        "INFO",
        `More context requested | requestId=${requestId} | originalLen=${originalAnswer.length} | resolvedUrl=${resolvedUrl}`
      );

      chrome.runtime.sendMessage({
        type: "expand-answer",
        requestId,
        resolvedUrl,
        headline,
        originalAnswer,
      });
    });
  }

  function enableMoreContextButton() {
    if (!tooltipEl) return;
    const btn = tooltipEl.querySelector("#nobait-tooltip-more-context");
    if (!btn || btn.dataset.consumed === "1") return;
    btn.disabled = false;
    btn.title = "Get a longer, more detailed answer (one click per long-press, capped at 500 chars)";
  }

  // Wires the "Debug info" toggle. Clicking expands or collapses the
  // extras section (resolved URL + copy buttons + monospace debug dump).
  // The toggle exists in both the answer state and the block state — both
  // share the same #nobait-tooltip-extras target.
  function wireDebugToggleButton() {
    if (!tooltipEl) return;
    const btn = tooltipEl.querySelector("#nobait-tooltip-toggle-debug");
    if (!btn) return;

    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const extras = tooltipEl && tooltipEl.querySelector("#nobait-tooltip-extras");
      if (!extras) return;
      const willShow = extras.classList.contains("nobait-extras-hidden");
      extras.classList.toggle("nobait-extras-hidden", !willShow);
      btn.textContent = willShow ? "Hide debug" : "Debug info";
      btn.classList.toggle("nobait-debug-open", willShow);
      log("INFO", `Debug info ${willShow ? "expanded" : "collapsed"}`);
      const rect = tooltipEl.getBoundingClientRect();
      positionTooltip(rect.left, rect.top - TOOLTIP_OFFSET_Y);
    });
  }

  // Swaps the answer with the expanded version on success, or shows a
  // brief error inline. Either way the button is marked consumed so it
  // can't fire again for this long-press.
  function applyMoreContextResult(message) {
    if (!tooltipEl) return;
    const btn = tooltipEl.querySelector("#nobait-tooltip-more-context");
    const answerEl = tooltipEl.querySelector("#nobait-tooltip-answer");
    if (btn) {
      btn.classList.remove("nobait-action-pending");
      btn.disabled = true;
      btn.dataset.consumed = "1";
    }
    if (answerEl) answerEl.classList.remove("nobait-answer-expanding");

    if (message.error) {
      if (btn) btn.textContent = "Expansion failed";
      log("WARN", `More context failed: ${message.error}`);
      // Don't blow away the original answer on failure
      return;
    }

    if (message.answer && answerEl) {
      answerEl.textContent = message.answer;
      answerEl.classList.add("nobait-answer-expanded");
      if (btn) btn.textContent = "Expanded ✓";
      if (activeMeta && activeMeta.requestId === message.requestId) {
        activeMeta.expandedAnswer = message.answer;
        activeMeta.expandedAiCallMs = message.aiCallMs || null;
        activeMeta.expandedChars = message.answer.length;
      }
    } else if (btn) {
      btn.textContent = "No expansion";
    }

    const rect = tooltipEl.getBoundingClientRect();
    positionTooltip(rect.left, rect.top - TOOLTIP_OFFSET_Y);
  }

  // Replaces the "Reading the article" area with a paywall/bot-block
  // status, four alternative-action buttons, and an empty result region
  // that gets populated when archive/best-guess responses arrive.
  // The URL section below stays intact.
  function setTooltipBlocked(blockMessage) {
    if (!tooltipEl) return;
    const area = tooltipEl.querySelector("#nobait-tooltip-answer-area");
    if (!area) return;

    const block = blockMessage.block || {};
    const publisher = block.publisher || (function () {
      try { return new URL(blockMessage.resolvedUrl).hostname.replace(/^www\./, ""); }
      catch { return "this site"; }
    })();

    let headlineLabel, description;
    if (block.kind === "paywall") {
      headlineLabel = "Paywall detected";
      description = `${publisher} requires a subscription to read the full article.`;
    } else if (block.kind === "redirect-failed") {
      headlineLabel = "Couldn't resolve redirect";
      description = `The redirect from ${publisher} to the actual article didn't complete in time. The link may still open normally in your browser, or use the alternatives below.`;
    } else {
      headlineLabel = "Site blocked the request";
      description = `${publisher} rejected the request (${block.reason || "blocked"}). The article may still load in your browser.`;
    }

    // Button order requested by user: best guess, alt source, archive,
    // google, ddg, debug — all in one row. The toggle-debug button is part
    // of the same row so it lines up on the far right.
    area.innerHTML =
      `<div id="nobait-tooltip-answer-label" class="nobait-block-label">${escapeHtml(headlineLabel)}</div>` +
      `<div id="nobait-tooltip-block-status">${escapeHtml(publisher)}</div>` +
      `<div id="nobait-tooltip-block-message">${escapeHtml(description)}</div>` +
      buildActionRowHtml("block") +
      `<div id="nobait-tooltip-block-result"></div>`;

    wireBlockActionButtons(blockMessage);
    wireDebugToggleButton();

    const rect = tooltipEl.getBoundingClientRect();
    positionTooltip(rect.left, rect.top - TOOLTIP_OFFSET_Y);
  }

  // Settings-driven button definitions. `key` matches the settings flag.
  // `auto` and `enabled` are read from cachedSettings at render time.
  // Buttons appear in this order in the action row.
  const FALLBACK_BUTTON_DEFS = [
    { key: "jsonLd",    action: "jsonLd",    label: "Embed body" },
    { key: "metaDesc",  action: "metaDesc",  label: "Page summary" },
    { key: "cookies",   action: "cookies",   label: "Use cookies" },
    { key: "amp",       action: "amp",       label: "AMP" },
    { key: "twelveFt",  action: "twelveFt",  label: "12ft.io" },
    { key: "altSource", action: "alt-source", label: "Alt source" },
    { key: "archive",   action: "archive",   label: "Try archive" },
  ];

  // Builds the action-row HTML based on cached settings. `state` is
  // "answer" (post-summary, leads with More context) or "block" (paywall etc.,
  // leads with Best guess). Settings-driven buttons are shown if enabled;
  // ones with auto=true render disabled with a green-tint and hover tooltip.
  // Always-on tail: Google, DuckDuckGo, Debug info.
  function buildActionRowHtml(state) {
    const settings = cachedSettings || { fallbacks: {} };
    const fb = settings.fallbacks || {};

    let html = `<div id="nobait-tooltip-block-actions"`;
    if (state === "answer") html += ` class="nobait-actions-answer-state"`;
    html += `>`;

    if (state === "answer") {
      html +=
        `<button id="nobait-tooltip-more-context" type="button" disabled ` +
        `title="Available after a successful AI summary — one click per long-press">More context</button>`;
    } else if (state === "block") {
      html +=
        `<button data-action="best-guess" type="button" ` +
        `title="Ask the model for topic context based on training data (no source content)">Best guess</button>`;
    }

    for (const def of FALLBACK_BUTTON_DEFS) {
      const entry = fb[def.key];
      if (!entry || !entry.enabled) continue;
      const isAuto = !!entry.auto;
      if (isAuto) {
        html +=
          `<button data-action="${def.action}" type="button" disabled ` +
          `class="nobait-action-auto" ` +
          `title="Runs automatically as part of the long-click chain (settings)">` +
          `${escapeHtml(def.label)} ⚡</button>`;
      } else {
        html +=
          `<button data-action="${def.action}" type="button" ` +
          `title="Click to manually run this fallback">${escapeHtml(def.label)}</button>`;
      }
    }

    if (fb.google && fb.google.enabled) {
      html += `<button data-action="google" type="button" title="Open a Google search for this headline">Google</button>`;
    }
    if (fb.ddg && fb.ddg.enabled) {
      html += `<button data-action="ddg" type="button" title="Open a DuckDuckGo search for this headline">DuckDuckGo</button>`;
    }
    if (fb.debugInfo && fb.debugInfo.enabled) {
      html +=
        `<button id="nobait-tooltip-toggle-debug" type="button" ` +
        `title="Show resolved URL + copy buttons + debug info">Debug info</button>`;
    }

    html += `</div>`;
    return html;
  }

  // Hooks up click handlers for the action buttons inside the block UI.
  // Each handler sends a message to background and updates the in-tooltip
  // result region; the search buttons just open a new tab and flash a label.
  // The Debug info button is in the same row but skipped here (it has its
  // own wirer in wireDebugToggleButton) — distinguished by lack of data-action.
  function wireBlockActionButtons(blockMessage) {
    if (!tooltipEl) return;
    const buttons = tooltipEl.querySelectorAll("#nobait-tooltip-block-actions button[data-action]");
    buttons.forEach((btn) => {
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const action = btn.dataset.action;
        // Read activeMeta DYNAMICALLY at click time, not wire time. In the
        // answer-state path, setTooltipResult wires these buttons before
        // clickbait-answer arrives — so articleTitle isn't on activeMeta
        // yet when the buttons are wired. By the time the user clicks,
        // articleTitle has been merged in. Capture-time read would miss it.
        const liveMeta = (activeMeta && activeMeta.requestId === blockMessage.requestId) ? activeMeta : {};
        const headline =
          (blockMessage.headline && blockMessage.headline.trim()) ||
          (liveMeta.headline && liveMeta.headline.trim()) ||
          (blockMessage.articleTitle && blockMessage.articleTitle.trim()) ||
          (liveMeta.articleTitle && liveMeta.articleTitle.trim()) ||
          "";
        const originalUrl = blockMessage.originalUrl || liveMeta.originalUrl || blockMessage.resolvedUrl;
        const resolvedUrl = blockMessage.resolvedUrl || liveMeta.resolvedUrl;
        const articleDate = blockMessage.articleDate || liveMeta.articleDate || null;
        const articleTitle = blockMessage.articleTitle || liveMeta.articleTitle || null;
        log(
          "INFO",
          `Block action "${action}" fired | headline="${headline.slice(0, 80)}" (${headline.length} chars) | ` +
            `articleDate=${articleDate || "n/a"} | articleTitle="${(articleTitle || "n/a").slice(0, 80)}"`
        );

        if (action === "google" || action === "ddg") {
          const engine = action === "ddg" ? "duckduckgo" : "google";
          const query = headline || resolvedUrl;
          chrome.runtime.sendMessage({ type: "open-search", engine, query });
          flashButton(btn, "Opening…");
          log("INFO", `Block action: open ${engine} search for "${query.slice(0, 80)}"`);
          return;
        }

        if (action === "archive") {
          setBlockResult("Searching the Wayback Machine…", "loading");
          disableBlockButton(btn, "Searching…");
          chrome.runtime.sendMessage({
            type: "try-archive",
            requestId: blockMessage.requestId,
            url: resolvedUrl,
            headline,
          });
          log("INFO", `Block action: try-archive for ${resolvedUrl}`);
          return;
        }

        if (action === "best-guess") {
          setBlockResult("Asking the model for topic context…", "loading");
          disableBlockButton(btn, "Thinking…");
          chrome.runtime.sendMessage({
            type: "try-best-guess",
            requestId: blockMessage.requestId,
            headline,
            originalUrl,
            resolvedUrl,
            articleDate,
          });
          log("INFO", `Block action: try-best-guess for "${headline.slice(0, 80)}"`);
          return;
        }

        if (action === "alt-source") {
          setBlockResult(
            `Searching up to 5 alternative sources for an unblocked version…`,
            "loading"
          );
          disableBlockButton(btn, "Searching…");
          chrome.runtime.sendMessage({
            type: "try-alt-source",
            requestId: blockMessage.requestId,
            headline,
            articleTitle,
            originalUrl,
            resolvedUrl,
            articleDate,
          });
          log("INFO", `Block action: try-alt-source | query="${headline.slice(0, 80)}" | originalUrl=${originalUrl} | date=${articleDate || "n/a"}`);
          return;
        }

        // Manual fallback actions (settings-driven buttons): jsonLd, metaDesc,
        // cookies, amp, twelveFt. All routed through the unified try-fallback
        // handler in background.js.
        const MANUAL_FALLBACK_ACTIONS = new Set(["jsonLd", "metaDesc", "cookies", "amp", "twelveFt"]);
        if (MANUAL_FALLBACK_ACTIONS.has(action)) {
          const labelMap = {
            jsonLd:   "embedded body",
            metaDesc: "page summary",
            cookies:  "cookied refetch",
            amp:      "AMP version",
            twelveFt: "12ft.io proxy",
          };
          setBlockResult(`Trying ${labelMap[action]}…`, "loading");
          disableBlockButton(btn, "Trying…");
          chrome.runtime.sendMessage({
            type: "try-fallback",
            method: action,
            requestId: blockMessage.requestId,
            headline,
            originalUrl,
            resolvedUrl,
          });
          log("INFO", `Manual fallback: ${action} | resolvedUrl=${resolvedUrl}`);
          return;
        }
      });
    });
  }

  // Flashes a button label briefly without disabling it (for the
  // open-search buttons that don't have an async result).
  function flashButton(btn, label, durationMs = 1200) {
    const original = btn.textContent;
    btn.textContent = label;
    btn.classList.add("nobait-action-flash");
    setTimeout(() => {
      if (!btn.isConnected) return;
      btn.textContent = original;
      btn.classList.remove("nobait-action-flash");
    }, durationMs);
  }

  function disableBlockButton(btn, pendingLabel) {
    btn.disabled = true;
    btn.dataset.originalLabel = btn.textContent;
    btn.textContent = pendingLabel;
    btn.classList.add("nobait-action-pending");
  }

  function reEnableBlockButton(action) {
    if (!tooltipEl) return;
    const btn = tooltipEl.querySelector(
      `#nobait-tooltip-block-actions button[data-action="${action}"]`
    );
    if (!btn) return;
    btn.disabled = false;
    btn.classList.remove("nobait-action-pending");
    if (btn.dataset.originalLabel) {
      btn.textContent = btn.dataset.originalLabel;
      delete btn.dataset.originalLabel;
    }
  }

  // Renders into the result region under the action buttons. `kind` is
  // 'loading' | 'success' | 'error' | 'archive' | 'best-guess' for styling.
  function setBlockResult(htmlOrText, kind) {
    if (!tooltipEl) return;
    const region = tooltipEl.querySelector("#nobait-tooltip-block-result");
    if (!region) return;
    region.className = `nobait-block-result-${kind || "info"}`;
    if (kind === "archive" || kind === "best-guess" || kind === "alt-source" || kind === "fallback" || kind === "raw-html") {
      region.innerHTML = htmlOrText; // pre-built HTML — caller is responsible for escaping
    } else {
      region.textContent = htmlOrText;
    }
    const rect = tooltipEl.getBoundingClientRect();
    positionTooltip(rect.left, rect.top - TOOLTIP_OFFSET_Y);
  }

  // Builds the archive-result payload as escaped HTML. If a summary was
  // produced, shows it plus a link to the snapshot. Otherwise shows the
  // error and offers manual archive links.
  function renderArchiveResult(result) {
    if (result.found && result.answer) {
      const dateLabel = result.snapshotDate
        ? `Wayback snapshot from ${escapeHtml(result.snapshotDate)}`
        : "Wayback snapshot";
      return (
        `<div class="nobait-block-result-label">From archive</div>` +
        `<div class="nobait-block-result-answer">${escapeHtml(result.answer)}</div>` +
        `<div class="nobait-block-result-source">` +
          `${dateLabel} · ` +
          `<a href="${escapeHtml(result.archiveUrl)}" target="_blank" rel="noopener noreferrer">Open snapshot</a>` +
        `</div>`
      );
    }
    if (result.found && !result.answer) {
      return (
        `<div class="nobait-block-result-label nobait-block-result-warn">Snapshot found but unreadable</div>` +
        `<div class="nobait-block-result-detail">${escapeHtml(result.error || "Unknown error")}</div>` +
        `<div class="nobait-block-result-source">` +
          `<a href="${escapeHtml(result.archiveUrl)}" target="_blank" rel="noopener noreferrer">Open snapshot manually</a>` +
        `</div>`
      );
    }
    // Not found
    const guess = result.archiveUrlGuess || "";
    const ph = result.archivePhUrl || "";
    return (
      `<div class="nobait-block-result-label nobait-block-result-warn">Not in Wayback Machine</div>` +
      `<div class="nobait-block-result-detail">${escapeHtml(result.error || result.reason || "No snapshot indexed.")}</div>` +
      `<div class="nobait-block-result-source">` +
        (guess ? `<a href="${escapeHtml(guess)}" target="_blank" rel="noopener noreferrer">Browse Wayback</a> · ` : "") +
        (ph ? `<a href="${escapeHtml(ph)}" target="_blank" rel="noopener noreferrer">Try archive.ph</a>` : "") +
      `</div>`
    );
  }

  // Renders the alt-source result. Success: shows the AI summary plus
  // citation (publisher + date + link). Failure: lists every source we
  // tried and why each one was rejected (paywall, bot-block, same publisher,
  // text too short, network error).
  function renderAltSourceResult(result) {
    const fmtAttempts = (attempts) => {
      if (!attempts || attempts.length === 0) return "";
      const lines = attempts.map((a) =>
        `<li><strong>${escapeHtml(a.source || "(unknown)")}</strong> — ${escapeHtml(a.reason || "blocked")}</li>`
      );
      return `<ul class="nobait-alt-attempts">${lines.join("")}</ul>`;
    };

    if (result.found && result.answer) {
      const meta = [];
      if (result.publisher || result.source) meta.push(escapeHtml(result.publisher || result.source));
      if (result.articleDate) meta.push(escapeHtml(result.articleDate));
      const metaLine = meta.join(" · ");
      const link = result.articleUrl
        ? `<a href="${escapeHtml(result.articleUrl)}" target="_blank" rel="noopener noreferrer">Open article</a>`
        : "";

      const triedNote =
        result.attempts && result.attempts.length > 0
          ? `<details class="nobait-alt-tried"><summary>Tried ${result.attempts.length} other source${result.attempts.length === 1 ? "" : "s"} first</summary>${fmtAttempts(result.attempts)}</details>`
          : "";

      return (
        `<div class="nobait-block-result-label">Summary from alternative source</div>` +
        `<div class="nobait-block-result-answer">${escapeHtml(result.answer)}</div>` +
        `<div class="nobait-block-result-source">${metaLine}${link ? " · " + link : ""}</div>` +
        triedNote
      );
    }

    // Not found — list everything we tried.
    const attempts = result.attempts || [];
    const headerText = attempts.length > 0
      ? `No alternative source found — tried ${attempts.length}, all blocked or unsuitable:`
      : (result.error || "No alternative source found.");
    return (
      `<div class="nobait-block-result-label nobait-block-result-warn">No alternative source available</div>` +
      `<div class="nobait-block-result-detail">${escapeHtml(headerText)}</div>` +
      fmtAttempts(attempts) +
      (result.error && attempts.length > 0
        ? `<div class="nobait-block-result-detail">${escapeHtml(result.error)}</div>`
        : "")
    );
  }

  function renderBestGuessResult(result) {
    if (result.error) {
      return (
        `<div class="nobait-block-result-label nobait-block-result-warn">Topic context unavailable</div>` +
        `<div class="nobait-block-result-detail">${escapeHtml(result.error)}</div>`
      );
    }
    return (
      `<div class="nobait-block-result-label">Topic context (from training data)</div>` +
      `<div class="nobait-block-result-answer">${escapeHtml(result.answer || "(empty)")}</div>`
    );
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
    activeRequestId = null;
    activeMeta = null;
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
      `--- NoBait Debug ---`,
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
  // Sections: identity → URL resolution → article fetch → AI call → answer →
  // raw event log → error fields → environment.
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

    const meta = activeMeta && activeMeta.requestId === info.requestId ? activeMeta : {};
    const fmt = (v) => (v === undefined || v === null ? "n/a" : String(v));

    // Compose a "best known" view of the article identity from all available
    // sources (anchor scrape, og:title from fetch, AI meta, etc.).
    const bestHeadline =
      (meta.headline && meta.headline.trim()) ||
      (meta.detectedHeadline && meta.detectedHeadline.trim()) ||
      (meta.articleTitle && meta.articleTitle.trim()) ||
      articleTitle ||
      "(none captured)";
    const bestPublisher = (function () {
      try {
        const u = new URL(info.resolvedUrl || info.originalUrl || "");
        return u.hostname.replace(/^www\./, "");
      } catch { return publisher; }
    })();
    const bestDate = meta.articleDate || "(unknown)";

    const lines = [
      `=== NoBait debug dump ===`,
      ``,
      `╔══ Article identity ══════════════════════════════════════════╗`,
      ` headline          : ${bestHeadline}`,
      ` publisher         : ${bestPublisher}`,
      ` date              : ${bestDate}`,
      ` finalUrl          : ${info.resolvedUrl || "(unresolved)"}`,
      ` originalUrl       : ${info.originalUrl || "(unknown)"}`,
      `╚══════════════════════════════════════════════════════════════╝`,
      ``,
      `extension         : NoBait ${extensionVersion}`,
      `requestId         : ${info.requestId || "unknown"}`,
      `timestamp         : ${new Date().toISOString()}`,
      `pageUrl           : ${window.location.href}`,
      ``,
      `--- Anchor scrape ---`,
      `anchorText        : ${articleTitle}`,
      `anchorPublisher   : ${publisher}`,
      `detectedHeadline  : ${fmt(meta.detectedHeadline)} (${fmt(meta.headlineLength)} chars)`,
      ``,
      `--- URL resolution ---`,
      `originalUrl       : ${info.originalUrl || "unknown"}`,
      `resolvedUrl       : ${info.resolvedUrl || "unknown"}`,
      `resolverPath      : ${info.method || "unknown"}`,
      `redirected        : ${fmt(info.redirected)}`,
      `httpStatus        : ${fmt(info.status)}`,
      `resolveMs         : ${fmt(info.resolveMs)}  (noTab=${fmt(info.noTabMs)}, tab=${fmt(info.tabMs)})`,
      `roundTripMs       : ${fmt(info.roundTripMs)}  (CS→BG→CS for resolve)`,
      ``,
      `--- Article fetch ---`,
      `articleHttpStatus : ${fmt(meta.articleHttpStatus)}`,
      `articleHtmlBytes  : ${fmt(meta.articleHtmlBytes)}`,
      `articleRegionUsed : ${fmt(meta.articleRegionUsed)}  (article|main|body|raw)`,
      `articleTextChars  : ${fmt(meta.articleLength)} / ${fmt(meta.articleMaxChars)} cap`,
      `articleFetchMs    : ${fmt(meta.articleFetchMs)}`,
      `articleDate       : ${fmt(meta.articleDate)}`,
      `articleTitle      : ${fmt(meta.articleTitle)}`,
      ``,
      `--- Block detection ---`,
      `blockKind         : ${fmt(meta.blockKind)}  (paywall|bot-block|null)`,
      `blockReason       : ${fmt(meta.blockReason)}`,
      `blockPublisher    : ${fmt(meta.blockPublisher)}`,
      ``,
      `--- AI call ---`,
      `promptVersion     : ${fmt(meta.promptVersion)}`,
      `promptChars       : ${fmt(meta.promptChars)}`,
      `cacheHit          : ${fmt(meta.cacheHit)}`,
      `workerStatus      : ${fmt(meta.workerStatus)}`,
      `aiCallMs          : ${fmt(meta.aiCallMs)}`,
      `pipelineMs        : ${fmt(meta.pipelineMs)}  (article fetch + AI call, end-to-end)`,
      `fallbackMethod    : ${fmt(meta.fallbackMethod)}  (jsonLd|metaDesc|cookies|amp|twelveFt|altSource|archive|null)`,
      ``,
      `--- Answer ---`,
      `answerChars       : ${fmt(meta.answerChars)} / ${fmt(meta.promptMaxChars)} cap`,
      `answer            : ${fmt(meta.answer)}`,
      `rawAnswer         : ${fmt(meta.rawAnswer)}`,
      `answerError       : ${fmt(meta.answerError)}`,
      ``,
      `--- Block actions taken ---`,
      `archiveResult     : ${meta.archiveResult ? JSON.stringify(meta.archiveResult) : "n/a"}`,
      `bestGuessResult   : ${meta.bestGuessResult ? JSON.stringify(meta.bestGuessResult) : "n/a"}`,
      `altSourceResult   : ${meta.altSourceResult ? JSON.stringify(meta.altSourceResult) : "n/a"}`,
      ``,
      `--- More context (expansion) ---`,
      `expandedChars     : ${fmt(meta.expandedChars)} / 500 cap`,
      `expandedAiCallMs  : ${fmt(meta.expandedAiCallMs)}`,
      `expandedAnswer    : ${fmt(meta.expandedAnswer)}`,
      ``,
      `--- In-popup event log ---`,
      debugLog.join("\n"),
      ``,
      `--- Error fields (resolve) ---`,
      `error             : ${info.error || "none"}`,
      `errorName         : ${info.errorName || "none"}`,
      `errorStack        : ${info.errorStack || "none"}`,
      `success           : ${fmt(info.success)}`,
      ``,
      `--- Environment ---`,
      `userAgent         : ${navigator.userAgent}`,
      `viewport          : ${window.innerWidth}x${window.innerHeight}`,
      `=== end dump ===`,
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

  // Extracts the best-effort article headline for an anchor. Many news
  // aggregators (Google News, Reddit, etc.) wrap the headline in a sibling
  // element rather than the anchor's textContent — for those the anchor
  // itself is text-empty (image-only). Search outward from the anchor:
  //   1. anchor.textContent
  //   2. anchor.title / aria-label
  //   3. closest article-like container's first heading
  //   4. parent's textContent (capped)
  function extractHeadlineFromAnchor(anchor) {
    if (!anchor) return "";
    const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

    // 1. Direct text
    let text = clean(anchor.textContent);
    if (text.length >= 10) return text.slice(0, 300);

    // 2. Title / aria-label
    text = clean(anchor.title) || clean(anchor.getAttribute("aria-label"));
    if (text.length >= 10) return text.slice(0, 300);

    // 3. Closest article container heading
    const container = anchor.closest("article, [role='article'], li, div");
    if (container) {
      const heading = container.querySelector(
        "h1, h2, h3, h4, [role='heading'], a[href][aria-label]"
      );
      if (heading) {
        text =
          clean(heading.getAttribute("aria-label")) ||
          clean(heading.textContent);
        if (text.length >= 10) return text.slice(0, 300);
      }
    }

    // 4. Sibling text — for layouts where the headline is right next to
    //    the icon-link inside the same parent.
    const parent = anchor.parentElement;
    if (parent) {
      text = clean(parent.textContent);
      if (text.length >= 10 && text.length < 600) return text.slice(0, 300);
    }

    return "";
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

    // Ignore mousedowns that originate inside our own tooltip — otherwise
    // holding on an action-result link (e.g. "Open snapshot") would fire
    // a recursive resolve on that archive URL.
    if (tooltipEl && tooltipEl.contains(e.target)) return;

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
      // Best-effort headline extraction: looks at the anchor, then any
      // ancestor heading, then sibling text. Critical for icon-only links
      // (Google News, Reddit) where anchor.textContent is empty.
      const linkText = extractHeadlineFromAnchor(anchor);
      log("INFO", `Headline for hold: "${linkText.slice(0, 100)}" (${linkText.length} chars)`);
      resolveAndShow(href, startX, startY, linkText);
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

  // Capture-phase click handler with two jobs:
  // 1. Swallow the mouseup-triggered click after a long-hold popup appears
  //    (so the underlying anchor doesn't navigate). Clears the flag immediately
  //    so only that one click is suppressed; short clicks pass through normally.
  // 2. If the tooltip is up and the user clicks anywhere outside it, dismiss
  //    the tooltip (but let the click do its normal thing — link, button, etc.).
  function onClickCapture(e) {
    if (suppressNextClick) {
      suppressNextClick = false;
      e.preventDefault();
      e.stopImmediatePropagation();
      log("INFO", "Suppressed post-popup click on anchor (long-hold popup was active)");
      return;
    }

    if (tooltipEl && !tooltipEl.contains(e.target)) {
      log("INFO", "Click outside tooltip — dismissing");
      removeTooltip();
    }
  }

  // ── Resolve and display ────────────────────────────────────────────

  function resolveAndShow(url, x, y, linkText) {
    const reqId = `req-${++requestCounter}-${Date.now()}`;
    // Capture anchor reference now — activeAnchor may be cleared by the time
    // the async response arrives.
    const capturedAnchor = activeAnchor;
    const sentAt = Date.now();

    log("INFO", `Sending resolve request | requestId=${reqId} | url=${url} | linkText="${linkText || ""}"`);

    const tip = createTooltip(x, y);
    if (!tip) {
      log("ERROR", "Failed to create tooltip element");
      return;
    }

    // Set activeRequestId AFTER createTooltip — createTooltip calls removeTooltip
    // internally, which would otherwise clobber this back to null and cause the
    // async clickbait answer to be discarded as stale.
    activeRequestId = reqId;
    activeMeta = {
      requestId: reqId,
      sentAt: new Date(sentAt).toISOString(),
      extensionVersion,
      headline: linkText || "",
    };

    // Popup is now visible — arm the click suppressor so the mouseup-triggered
    // click on the underlying anchor doesn't navigate the page away.
    suppressNextClick = true;
    log("INFO", "suppressNextClick armed — next page click will be swallowed");

    setTooltipLoading(url);

    chrome.runtime.sendMessage(
      { type: "resolve-url", url: url, linkText: linkText || "", requestId: reqId },
      (response) => {
        const roundTripMs = Date.now() - sentAt;
        if (chrome.runtime.lastError) {
          const errMsg = chrome.runtime.lastError.message;
          log(
            "ERROR",
            `chrome.runtime.sendMessage failed after ${roundTripMs}ms | requestId=${reqId}\n` +
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
            `No response received from background after ${roundTripMs}ms | requestId=${reqId}\n` +
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

        log(
          "INFO",
          `Response received in ${roundTripMs}ms | requestId=${reqId} | success=${response.success} | method=${response.method} | resolveMs=${response.resolveMs} (noTab=${response.noTabMs}, tab=${response.tabMs})`
        );

        if (activeMeta && activeMeta.requestId === reqId) {
          activeMeta.roundTripMs = roundTripMs;
          activeMeta.resolveMs = response.resolveMs;
          activeMeta.noTabMs = response.noTabMs;
          activeMeta.tabMs = response.tabMs;
          activeMeta.method = response.method;
          activeMeta.redirected = response.redirected;
        }

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
              resolveMs: response.resolveMs,
              noTabMs: response.noTabMs,
              tabMs: response.tabMs,
              roundTripMs,
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

  // ── Async result receiver ──────────────────────────────────────────
  // Background pushes results back as separate messages after URL resolution.
  // Routes by type: clickbait-answer | clickbait-blocked | archive-result |
  // best-guess-result. Stale results (different requestId) are ignored.
  chrome.runtime.onMessage.addListener((message) => {
    if (!message || !message.type) return;
    const t = message.type;
    if (
      t !== "clickbait-answer" &&
      t !== "clickbait-blocked" &&
      t !== "archive-result" &&
      t !== "best-guess-result" &&
      t !== "alt-source-result" &&
      t !== "more-context-result" &&
      t !== "fallback-result" &&
      t !== "progress-update" &&
      t !== "debug-event"
    ) return;

    if (message.requestId !== activeRequestId) {
      log("INFO", `Ignoring stale ${t} for ${message.requestId}`);
      return;
    }
    if (!tooltipEl) {
      log("INFO", `${t} arrived but tooltip already dismissed: ${message.requestId}`);
      return;
    }

    if (t === "progress-update") {
      // Background is streaming a status line while the fallback chain runs.
      // Keep the answer-thinking class so the animated dots persist.
      const answerEl = tooltipEl.querySelector("#nobait-tooltip-answer");
      if (answerEl && answerEl.classList.contains("nobait-answer-thinking")) {
        answerEl.textContent = message.status || "Working";
      }
      log("INFO", `Progress: ${message.status}`);
      return;
    }

    if (t === "debug-event") {
      // Background-side granular event, just appended to in-popup debug log
      // for visibility in Copy Debug. Doesn't change anything visible.
      log(message.level || "INFO", `[BG] ${message.message}`);
      return;
    }

    if (t === "clickbait-answer") {
      const m = message.meta || {};
      log(
        "INFO",
        `Clickbait answer for ${message.requestId} | ` +
          `cacheHit=${m.cacheHit} | pipelineMs=${m.pipelineMs} | ` +
          `articleFetchMs=${m.articleFetchMs} | aiCallMs=${m.aiCallMs} | ` +
          `articleLen=${m.articleLength} | answerLen=${m.answerChars} | ` +
          `fallbackMethod=${m.fallbackMethod || message.fallbackMethod || "n/a"} | ` +
          `promptVer=${m.promptVersion} | result="${
            message.answer ? message.answer : "error=" + message.error
          }"`
      );
      if (m.rawAnswer && m.rawAnswer !== message.answer) {
        log("INFO", `Raw model output (pre-trim) for ${message.requestId}: ${m.rawAnswer}`);
      }
      if (activeMeta && activeMeta.requestId === message.requestId) {
        Object.assign(activeMeta, m, {
          answer: message.answer || null,
          answerError: message.error || null,
          source: message.source || null,
          fallbackMethod: message.fallbackMethod || m.fallbackMethod || null,
        });
      }
      // If the answer came from a fallback, normalize source.method so
      // showSourceAttribution can render the right blurb.
      let source = message.source || null;
      if (source && !source.method && message.fallbackMethod) {
        source = { ...source, method: message.fallbackMethod };
      }
      updateTooltipAnswer(message.answer, message.error, source);
      return;
    }

    if (t === "clickbait-blocked") {
      const block = message.block || {};
      const m = message.meta || {};
      log(
        "INFO",
        `Block detected for ${message.requestId} | kind=${block.kind} | ` +
          `publisher=${block.publisher || "n/a"} | reason=${block.reason || block.detectedFrom || "n/a"} | ` +
          `pipelineMs=${m.pipelineMs} | articleHttpStatus=${m.articleHttpStatus} | articleLen=${m.articleLength}`
      );
      if (activeMeta && activeMeta.requestId === message.requestId) {
        Object.assign(activeMeta, m, {
          blockKind: block.kind,
          blockReason: block.reason || block.detectedFrom || block.publisher,
          blockPublisher: block.publisher || null,
          articleDate: message.articleDate || null,
          articleTitle: message.articleTitle || null,
          headline: message.headline || "",
          originalUrl: message.originalUrl || activeMeta.originalUrl,
          resolvedUrl: message.resolvedUrl || activeMeta.resolvedUrl,
        });
      }
      setTooltipBlocked(message);
      return;
    }

    if (t === "archive-result") {
      log(
        "INFO",
        `Archive result for ${message.requestId} | found=${message.found} | ` +
          `source=${message.source || "n/a"} | snapshotDate=${message.snapshotDate || "n/a"} | ` +
          `lookupMs=${(message.meta && message.meta.lookupMs) || message.lookupMs || "n/a"} | ` +
          `answerLen=${message.answer ? message.answer.length : 0} | error="${message.error || ""}"`
      );
      if (activeMeta && activeMeta.requestId === message.requestId) {
        activeMeta.archiveResult = {
          found: message.found,
          source: message.source,
          archiveUrl: message.archiveUrl,
          snapshotDate: message.snapshotDate,
          answer: message.answer,
          error: message.error || null,
        };
      }
      reEnableBlockButton("archive");
      setBlockResult(renderArchiveResult(message), "archive");
      return;
    }

    if (t === "best-guess-result") {
      log(
        "INFO",
        `Best-guess result for ${message.requestId} | aiCallMs=${message.aiCallMs || "n/a"} | ` +
          `answerLen=${message.answer ? message.answer.length : 0} | error="${message.error || ""}"`
      );
      if (activeMeta && activeMeta.requestId === message.requestId) {
        activeMeta.bestGuessResult = {
          answer: message.answer || null,
          aiCallMs: message.aiCallMs || null,
          error: message.error || null,
        };
      }
      reEnableBlockButton("best-guess");
      setBlockResult(renderBestGuessResult(message), "best-guess");
      return;
    }

    if (t === "alt-source-result") {
      log(
        "INFO",
        `Alt source result for ${message.requestId} | found=${message.found} | ` +
          `source=${message.source || "n/a"} | publisher=${message.publisher || "n/a"} | ` +
          `attempts=${(message.attempts || []).length} | error="${message.error || ""}"`
      );
      if (activeMeta && activeMeta.requestId === message.requestId) {
        activeMeta.altSourceResult = {
          found: message.found,
          source: message.source || null,
          publisher: message.publisher || null,
          articleUrl: message.articleUrl || null,
          articleDate: message.articleDate || null,
          answer: message.answer || null,
          attempts: message.attempts || [],
          error: message.error || null,
        };
      }
      reEnableBlockButton("alt-source");
      setBlockResult(renderAltSourceResult(message), "alt-source");
      return;
    }

    if (t === "fallback-result") {
      // Manual fallback (jsonLd/metaDesc/cookies/amp/twelveFt) result.
      log(
        "INFO",
        `Manual fallback "${message.method}" result | found=${message.found} | ` +
          `answerLen=${(message.answer || "").length} | error="${message.error || ""}"`
      );
      reEnableBlockButton(message.method);
      const labelMap = {
        jsonLd:   "embedded article body",
        metaDesc: "page metadata",
        cookies:  "cookied refetch",
        amp:      "AMP version",
        twelveFt: "12ft.io proxy",
      };
      const sourceLabel = labelMap[message.method] || message.method;
      if (message.found && message.answer) {
        let html =
          `<div class="nobait-block-result-label">Summary from ${escapeHtml(sourceLabel)}</div>` +
          `<div class="nobait-block-result-answer">${escapeHtml(message.answer)}</div>`;
        if (message.source && message.source.url) {
          html += `<div class="nobait-block-result-source">` +
            `<a href="${escapeHtml(message.source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(message.source.name || "Open source")}</a>` +
            `</div>`;
        }
        setBlockResult(html, "fallback");
      } else {
        setBlockResult(
          `<div class="nobait-block-result-label nobait-block-result-warn">${escapeHtml(sourceLabel)} unavailable</div>` +
          `<div class="nobait-block-result-detail">${escapeHtml(message.error || "No content returned.")}</div>`,
          "fallback"
        );
      }
      return;
    }

    if (t === "more-context-result") {
      log(
        "INFO",
        `More context result for ${message.requestId} | aiCallMs=${message.aiCallMs || "n/a"} | ` +
          `answerLen=${message.answer ? message.answer.length : 0} | error="${message.error || ""}"`
      );
      applyMoreContextResult(message);
      return;
    }
  });

  // ── Register listeners ─────────────────────────────────────────────
  document.addEventListener("mousedown", onMouseDown, true);
  document.addEventListener("mousemove", onMouseMove, true);
  document.addEventListener("mouseup", onMouseUp, true);
  document.addEventListener("keydown", onKeyDown, true);
  // Capture-phase click suppressor — must run before anchor's own click handler
  document.addEventListener("click", onClickCapture, true);

  // ── Settings cache + sync ──────────────────────────────────────────
  // Settings drive which fallback buttons appear in the tooltip and which
  // are styled as auto-running. Cache them on init; refresh when the
  // popup writes new values via chrome.storage.
  (async () => {
    try {
      const stored = await chrome.storage.local.get("nobaitSettings");
      cachedSettings = stored.nobaitSettings || null;
    } catch (e) {
      log("WARN", `Settings load failed: ${e.message}`);
    }
  })();
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.nobaitSettings) {
        cachedSettings = changes.nobaitSettings.newValue;
        log("INFO", "Settings updated from popup");
      }
    });
  } catch (e) { /* storage not available */ }

  log("INFO", `NoBait content script loaded on ${window.location.href}`);
})();
