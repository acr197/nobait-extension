// NoBait - Sidebar (Firefox)
// Scans the active tab for article links and lets the user click any of them
// to get the same AI summary as the on-page long-click trigger.

(function () {
  "use strict";

  // --- Cross-browser API shim ---
  const api = (typeof browser !== "undefined") ? browser : chrome;

  // --- Storage key (shared with popup-settings.js and content.js) ---
  const STORAGE_KEY = "triggerSettings";

  // --- DOM references ---
  const refreshBtn = document.getElementById("sb-refresh");
  const settingsToggleBtn = document.getElementById("sb-settings-toggle");
  const settingsPanel = document.getElementById("sb-settings");
  const pageTitleEl = document.getElementById("sb-page-title");
  const pageMetaEl = document.getElementById("sb-page-meta");
  const listEl = document.getElementById("sb-list");
  const emptyEl = document.getElementById("sb-empty");
  const emptyRescanBtn = document.getElementById("sb-empty-rescan");
  const unreadableEl = document.getElementById("sb-unreadable");
  const loadingEl = document.getElementById("sb-loading");

  const longClickEl = document.getElementById("sb-trigger-longclick");
  const shiftClickEl = document.getElementById("sb-trigger-shiftclick");
  const ctrlClickEl = document.getElementById("sb-trigger-ctrlclick");
  const debugModeEl = document.getElementById("sb-setting-debugmode");

  // --- Debug mode mirrors the popup setting; controls whether the modal
  //     summary appends a diagnostic log panel under the response. ---
  let debugMode = true;

  const modalEl = document.getElementById("sb-modal");
  const modalBackdrop = modalEl.querySelector(".sb-modal-backdrop");
  const modalCloseBtn = document.getElementById("sb-modal-close");
  const modalHeadlineEl = document.getElementById("sb-modal-headline");
  const modalBodyEl = document.getElementById("sb-modal-body");
  const modalOpenLink = document.getElementById("sb-modal-open");

  // --- Request sequencing: ignore summaries that arrive after the user
  //     closed/reopened the modal for a different article. ---
  let activeRequestId = 0;

  // =========================================================================
  // INITIALIZATION
  // =========================================================================

  loadSettings();
  renderVersionLabel();
  attachEventListeners();
  scanActiveTab();

  // --- renderVersionLabel: single source of truth is manifest.json. ---
  function renderVersionLabel() {
    try {
      const manifest = api.runtime.getManifest();
      const el = document.getElementById("sb-version");
      if (el && manifest && manifest.version) {
        el.textContent = "v" + manifest.version;
      }
    } catch (_) { /* ignore */ }
  }

  // Rescan when the user switches tabs or navigates the current tab
  if (api.tabs && api.tabs.onActivated) {
    api.tabs.onActivated.addListener(() => scanActiveTab());
  }
  if (api.tabs && api.tabs.onUpdated) {
    api.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (changeInfo.status === "complete" && tab && tab.active) {
        scanActiveTab();
      }
    });
  }

  // =========================================================================
  // EVENT LISTENERS
  // =========================================================================

  function attachEventListeners() {
    refreshBtn.addEventListener("click", () => {
      refreshBtn.classList.add("is-spinning");
      scanActiveTab().finally(() => {
        // Brief minimum spin so the feedback is visible
        setTimeout(() => refreshBtn.classList.remove("is-spinning"), 350);
      });
    });

    if (emptyRescanBtn) {
      emptyRescanBtn.addEventListener("click", () => {
        refreshBtn.classList.add("is-spinning");
        scanActiveTab().finally(() => {
          setTimeout(() => refreshBtn.classList.remove("is-spinning"), 350);
        });
      });
    }

    settingsToggleBtn.addEventListener("click", () => {
      settingsPanel.classList.toggle("hidden");
    });

    longClickEl.addEventListener("change", saveSettings);
    shiftClickEl.addEventListener("change", saveSettings);
    ctrlClickEl.addEventListener("change", saveSettings);
    debugModeEl.addEventListener("change", saveSettings);

    modalCloseBtn.addEventListener("click", closeModal);
    modalBackdrop.addEventListener("click", closeModal);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && modalEl.classList.contains("is-open")) {
        closeModal();
      }
    });
  }

  // =========================================================================
  // SETTINGS (mirrors popup-settings.js, so toggles from either place sync)
  // =========================================================================

  function loadSettings() {
    Promise.resolve(api.storage.sync.get([STORAGE_KEY]))
      .then((result) => {
        const s = result && result[STORAGE_KEY];
        if (!s) return;
        if (typeof s.longClick === "boolean") longClickEl.checked = s.longClick;
        if (typeof s.shiftClick === "boolean") shiftClickEl.checked = s.shiftClick;
        if (typeof s.ctrlClick === "boolean") ctrlClickEl.checked = s.ctrlClick;
        if (typeof s.debugMode === "boolean") {
          debugModeEl.checked = s.debugMode;
          debugMode = s.debugMode;
        }
      })
      .catch(() => { /* ignore */ });
  }

  function saveSettings() {
    debugMode = debugModeEl.checked;
    const settings = {
      longClick: longClickEl.checked,
      shiftClick: shiftClickEl.checked,
      ctrlClick: ctrlClickEl.checked,
      debugMode: debugModeEl.checked,
    };
    Promise.resolve(api.storage.sync.set({ [STORAGE_KEY]: settings })).catch(() => {});
  }

  // =========================================================================
  // PAGE SCANNING
  // =========================================================================

  async function getActiveTab() {
    const tabs = await Promise.resolve(api.tabs.query({ active: true, currentWindow: true }));
    return tabs && tabs[0];
  }

  function isReadableUrl(url) {
    if (!url) return false;
    try {
      const u = new URL(url);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch (_) {
      return false;
    }
  }

  async function scanActiveTab() {
    showState("loading");
    listEl.innerHTML = "";
    pageTitleEl.textContent = "";
    pageMetaEl.textContent = "";

    let tab;
    try {
      tab = await getActiveTab();
    } catch (_) {
      showUnreadable();
      return;
    }
    if (!tab) {
      showUnreadable();
      return;
    }

    // Privileged pages (about:, chrome:, moz-extension:, file:, etc.) cannot
    // be scanned. The sidebar intentionally shows NO articles in that case —
    // we only ever surface headlines from the current tab, never from a
    // cached fallback feed.
    if (!isReadableUrl(tab.url)) {
      showUnreadable();
      return;
    }

    // Update the page info header now that we know the tab is scannable.
    pageTitleEl.textContent = tab.title || "(untitled)";
    pageMetaEl.textContent = "";

    // Ask the content script to collect article links.
    let response;
    try {
      response = await Promise.resolve(
        api.tabs.sendMessage(tab.id, { type: "GET_ARTICLE_LINKS" })
      );
    } catch (err) {
      // Content script not present (injection blocked, restricted origin).
      showUnreadable();
      return;
    }

    if (!response || !response.ok || !Array.isArray(response.links)) {
      showUnreadable();
      return;
    }

    const links = response.links;
    if (links.length === 0) {
      showState("empty");
      pageMetaEl.textContent = hostnameOf(tab.url);
      return;
    }

    renderLinks(links);
    pageMetaEl.textContent = links.length + (links.length === 1 ? " article" : " articles") +
      " · " + hostnameOf(tab.url);
    showState("list");
  }

  function hostnameOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch (_) { return ""; }
  }

  // =========================================================================
  // RENDERING
  // =========================================================================

  function showState(state) {
    loadingEl.classList.toggle("hidden", state !== "loading");
    emptyEl.classList.toggle("hidden", state !== "empty");
    unreadableEl.classList.toggle("hidden", state !== "unreadable");
    listEl.classList.toggle("hidden", state !== "list");
  }

  function showUnreadable() {
    listEl.innerHTML = "";
    pageMetaEl.textContent = "";
    showState("unreadable");
  }

  function renderLinks(links) {
    const frag = document.createDocumentFragment();
    for (const link of links) {
      frag.appendChild(createCard(link));
    }
    listEl.innerHTML = "";
    listEl.appendChild(frag);
  }

  function createCard(link) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "sb-card";

    const headline = document.createElement("div");
    headline.className = "sb-card-headline";
    headline.textContent = link.headline;
    card.appendChild(headline);

    const meta = document.createElement("div");
    meta.className = "sb-card-meta";

    const source = document.createElement("span");
    source.className = "sb-card-source";
    source.textContent = link.source || hostnameOf(link.url);
    meta.appendChild(source);

    const arrow = document.createElement("span");
    arrow.className = "sb-card-arrow";
    arrow.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
    meta.appendChild(arrow);

    card.appendChild(meta);

    card.addEventListener("click", (e) => openSummary(link, e));
    return card;
  }

  // =========================================================================
  // SUMMARY MODAL
  // =========================================================================

  function openModal() {
    modalEl.classList.remove("hidden");
    // Force reflow so the transition applies
    void modalEl.offsetWidth;
    modalEl.classList.add("is-open");
    modalEl.setAttribute("aria-hidden", "false");
  }

  function closeModal() {
    activeRequestId++; // invalidate any in-flight request
    modalEl.classList.remove("is-open");
    modalEl.setAttribute("aria-hidden", "true");
    setTimeout(() => {
      if (!modalEl.classList.contains("is-open")) {
        modalEl.classList.add("hidden");
        // Reset body to loading state for the next open
        modalBodyEl.innerHTML = "";
        const loading = document.createElement("div");
        loading.className = "sb-modal-loading";
        loading.innerHTML = '<div class="sb-spinner"></div><div class="sb-modal-loading-text">Analyzing article\u2026</div>';
        modalBodyEl.appendChild(loading);
      }
    }, 220);
  }

  async function openSummary(link, event) {
    // Preferred path: ask the content script to render the popup in the page
    // itself, anchored near where the user clicked. Fall back to the inline
    // sidebar modal if the content script isn't reachable.
    const clientY = event && typeof event.clientY === "number" ? event.clientY : 120;
    try {
      const tab = await getActiveTab();
      if (tab && tab.id != null) {
        const resp = await Promise.resolve(
          api.tabs.sendMessage(tab.id, {
            type: "SHOW_POPUP_AT",
            url: link.url,
            headline: link.headline,
            // x: small left-edge offset puts the popup just inside the page
            // viewport, which is already to the right of the sidebar panel.
            x: 12,
            y: clientY,
          })
        );
        if (resp && resp.ok) return;
      }
    } catch (_) { /* fall through to the inline modal */ }

    openSummaryInModal(link);
  }

  async function openSummaryInModal(link) {
    modalHeadlineEl.textContent = link.headline;
    modalOpenLink.href = link.url;
    showModalLoading();
    openModal();
    await requestModalSummary(link, "short");
  }

  // --- requestModalSummary: shared path for the initial short summary and
  //     the "More context" detailed re-request. Uses activeRequestId to
  //     drop stale responses if the user closes or reopens the modal. ---
  async function requestModalSummary(link, mode) {
    const requestId = ++activeRequestId;
    showModalLoading();

    let response;
    try {
      response = await Promise.resolve(
        api.runtime.sendMessage({
          type: "SUMMARIZE",
          url: link.url,
          headline: link.headline,
          mode,
        })
      );
    } catch (err) {
      if (requestId !== activeRequestId) return;
      renderError("ai_error", "Extension error. Try again.", link.headline, {
        ok: false,
        error: "ai_error",
        message: "Extension error. Try again.",
        debug: [{
          t: 0,
          stage: "sendMessage",
          status: "fail",
          detail: (err && err.message) || String(err),
          data: null,
        }],
      });
      return;
    }

    if (requestId !== activeRequestId) return;

    if (!response) {
      renderError("ai_error", "No response from extension.", link.headline, null);
      return;
    }
    if (response.ok) {
      renderSummary(response, link, mode);
    } else {
      renderError(response.error, response.message, link.headline, response);
    }
  }

  function showModalLoading() {
    modalBodyEl.innerHTML = "";
    const loading = document.createElement("div");
    loading.className = "sb-modal-loading";
    loading.innerHTML =
      '<div class="sb-spinner"></div><div class="sb-modal-loading-text">Analyzing article\u2026</div>';
    modalBodyEl.appendChild(loading);
  }

  // --- renderSummary: displays the AI summary in the sidebar modal. Called
  //     on ok:true responses, which carry either:
  //       - source:"article" → the summary is grounded in fetched article text
  //       - source:"knowledge" → the fetch failed and the AI answered from
  //         web search / training data. We show an amber banner so the
  //         reader can tell which kind of answer they're looking at. ---
  function renderSummary(response, link, mode) {
    modalBodyEl.innerHTML = "";

    const wrap = document.createElement("div");
    wrap.className = "sb-modal-summary";

    if (response.source === "knowledge" || response.contentStatus === "from_knowledge") {
      const banner = document.createElement("div");
      banner.className = "sb-modal-status";
      banner.textContent =
        response.contentStatusMessage ||
        "Article couldn't be fetched — answer is from AI knowledge.";
      wrap.appendChild(banner);
    }

    const text = document.createElement("div");
    text.className = "sb-modal-summary-text";
    text.textContent = response.summary || "";
    wrap.appendChild(text);

    // Action row: "More context" + "Alternate source". Only on short mode.
    if (mode !== "detailed") {
      const actions = document.createElement("div");
      actions.className = "sb-modal-actions";

      const moreBtn = document.createElement("button");
      moreBtn.className = "sb-modal-more-btn";
      moreBtn.type = "button";
      moreBtn.textContent = "More context";
      moreBtn.addEventListener("click", () => {
        requestModalSummary(link, "detailed");
      });
      actions.appendChild(moreBtn);

      const altBtn = document.createElement("button");
      altBtn.className = "sb-modal-alt-btn";
      altBtn.type = "button";
      altBtn.textContent = "Alternate source";
      altBtn.addEventListener("click", () => {
        requestModalAlternateSource(link);
      });
      actions.appendChild(altBtn);

      wrap.appendChild(actions);
    }

    modalBodyEl.appendChild(wrap);
    appendDebugPanel(response);
  }

  // --- requestModalAlternateSource: asks the background to find a different
  //     publisher's coverage of the headline and renders the result. Tracks
  //     activeRequestId so closing the modal cancels the in-flight request. ---
  async function requestModalAlternateSource(link) {
    const requestId = ++activeRequestId;
    showModalLoading();
    const loading = modalBodyEl.querySelector(".sb-modal-loading-text");
    if (loading) loading.textContent = "Finding another source\u2026";

    let response;
    try {
      response = await Promise.resolve(
        api.runtime.sendMessage({
          type: "ALTERNATE_SOURCE",
          url: link.url,
          headline: link.headline,
        })
      );
    } catch (err) {
      if (requestId !== activeRequestId) return;
      renderError("alt_error", "Extension error. Try again.", link.headline, {
        ok: false,
        error: "alt_error",
        message: "Extension error. Try again.",
        debug: [{
          t: 0,
          stage: "sendMessage",
          status: "fail",
          detail: (err && err.message) || String(err),
          data: null,
        }],
      });
      return;
    }

    if (requestId !== activeRequestId) return;

    if (!response) {
      renderError("alt_error", "No response from extension.", link.headline, null);
      return;
    }
    if (response.ok) {
      renderAlternateSource(response, link);
    } else {
      renderError(response.error, response.message, link.headline, response);
    }
  }

  // --- renderAlternateSource: shows the alternate-source result in the
  //     modal. Includes date, publisher, clickable title, summary, and
  //     buttons to go back to the original article or fetch yet another. ---
  function renderAlternateSource(response, link) {
    modalBodyEl.innerHTML = "";

    const wrap = document.createElement("div");
    wrap.className = "sb-modal-summary";

    const label = document.createElement("div");
    label.className = "sb-modal-alt-label";
    label.textContent = "Alternate source";
    wrap.appendChild(label);

    const meta = document.createElement("div");
    meta.className = "sb-modal-alt-meta";
    const metaParts = [];
    if (response.date) metaParts.push(response.date);
    if (response.publisher) metaParts.push(response.publisher);
    meta.textContent = metaParts.join("  \u00B7  ");
    wrap.appendChild(meta);

    if (response.title) {
      const title = document.createElement("a");
      title.className = "sb-modal-alt-title";
      title.textContent = response.title;
      title.href = response.url || "#";
      title.target = "_blank";
      title.rel = "noopener noreferrer";
      wrap.appendChild(title);
    }

    const text = document.createElement("div");
    text.className = "sb-modal-summary-text";
    text.textContent = response.summary || "";
    wrap.appendChild(text);

    const actions = document.createElement("div");
    actions.className = "sb-modal-actions";

    const backBtn = document.createElement("button");
    backBtn.className = "sb-modal-more-btn";
    backBtn.type = "button";
    backBtn.textContent = "Original article";
    backBtn.addEventListener("click", () => {
      requestModalSummary(link, "short");
    });
    actions.appendChild(backBtn);

    const anotherBtn = document.createElement("button");
    anotherBtn.className = "sb-modal-alt-btn";
    anotherBtn.type = "button";
    anotherBtn.textContent = "Try another";
    anotherBtn.addEventListener("click", () => {
      requestModalAlternateSource(link);
    });
    actions.appendChild(anotherBtn);

    wrap.appendChild(actions);
    modalBodyEl.appendChild(wrap);
    appendDebugPanel(response);
  }

  function renderError(errorType, message, headline, response) {
    modalBodyEl.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "sb-modal-error";

    const icon = document.createElement("div");
    icon.className = "sb-modal-error-icon";
    icon.textContent = "\u26A0\uFE0F";
    wrap.appendChild(icon);

    const msg = document.createElement("div");
    msg.className = "sb-modal-error-msg";
    msg.textContent = message || "Summarization failed.";
    wrap.appendChild(msg);

    const btn = document.createElement("button");
    btn.className = "sb-modal-error-btn";
    btn.type = "button";
    btn.textContent = "Search Google";
    btn.addEventListener("click", () => {
      const q = encodeURIComponent(headline || "");
      window.open("https://www.google.com/search?q=" + q, "_blank", "noopener");
    });
    wrap.appendChild(btn);

    modalBodyEl.appendChild(wrap);
    appendDebugPanel(response);
  }

  // =========================================================================
  // DEBUG PANEL
  // =========================================================================

  // --- appendDebugPanel: appends a collapsible diagnostic log under the
  //     modal body when debug mode is on AND the background returned a
  //     debug array. Mirrors the on-page popup's panel so the user gets the
  //     same investigation surface no matter which UI they used. ---
  function appendDebugPanel(response) {
    if (!debugMode) return;
    if (!response || !Array.isArray(response.debug) || response.debug.length === 0) return;

    const panel = document.createElement("div");
    panel.className = "sb-debug-panel";

    const header = document.createElement("button");
    header.className = "sb-debug-header";
    header.type = "button";

    const chev = document.createElement("span");
    chev.className = "sb-debug-chev";
    chev.textContent = "\u25BE"; // ▾
    header.appendChild(chev);

    const title = document.createElement("span");
    title.className = "sb-debug-title";
    const last = response.debug[response.debug.length - 1];
    const totalMs = last && typeof last.t === "number" ? last.t : 0;
    title.textContent =
      "Debug log \u00B7 " + response.debug.length + " entries \u00B7 " + totalMs + "ms";
    header.appendChild(title);

    const copyBtn = document.createElement("span");
    copyBtn.className = "sb-debug-copy";
    copyBtn.textContent = "Copy";
    copyBtn.title = "Copy debug log to clipboard";
    copyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      copyDebugLog(response, copyBtn);
    });
    header.appendChild(copyBtn);

    header.addEventListener("click", () => {
      const collapsed = panel.classList.toggle("sb-debug-collapsed");
      chev.textContent = collapsed ? "\u25B8" : "\u25BE"; // ▸ : ▾
    });

    panel.appendChild(header);

    const body = document.createElement("div");
    body.className = "sb-debug-body";

    if (response.error || response.contentStatus || response.source) {
      const meta = document.createElement("div");
      meta.className = "sb-debug-meta";
      const parts = [];
      parts.push("ok=" + (response.ok ? "true" : "false"));
      if (response.error) parts.push("error=" + response.error);
      if (response.contentStatus) parts.push("contentStatus=" + response.contentStatus);
      if (response.source) parts.push("source=" + response.source);
      meta.textContent = parts.join(" \u00B7 ");
      body.appendChild(meta);
    }

    for (const entry of response.debug) {
      body.appendChild(buildDebugEntry(entry));
    }

    panel.appendChild(body);
    modalBodyEl.appendChild(panel);
  }

  function buildDebugEntry(entry) {
    const row = document.createElement("div");
    row.className = "sb-debug-entry sb-debug-" + (entry.status || "info");

    const line = document.createElement("div");
    line.className = "sb-debug-line";

    const time = document.createElement("span");
    time.className = "sb-debug-time";
    time.textContent = (typeof entry.t === "number" ? entry.t : 0) + "ms";
    line.appendChild(time);

    const stage = document.createElement("span");
    stage.className = "sb-debug-stage";
    stage.textContent = entry.stage || "?";
    line.appendChild(stage);

    const status = document.createElement("span");
    status.className = "sb-debug-status";
    status.textContent = (entry.status || "info").toUpperCase();
    line.appendChild(status);

    const detail = document.createElement("span");
    detail.className = "sb-debug-detail";
    detail.textContent = entry.detail || "";
    line.appendChild(detail);

    row.appendChild(line);

    if (entry.data && typeof entry.data === "object") {
      const data = document.createElement("div");
      data.className = "sb-debug-data";
      for (const key in entry.data) {
        const val = entry.data[key];
        if (val == null) continue;
        const kv = document.createElement("div");
        kv.className = "sb-debug-kv";
        const k = document.createElement("span");
        k.className = "sb-debug-key";
        k.textContent = key + ":";
        kv.appendChild(k);
        const v = document.createElement("span");
        v.className = "sb-debug-val";
        v.textContent = typeof val === "object" ? JSON.stringify(val) : String(val);
        kv.appendChild(v);
        data.appendChild(kv);
      }
      row.appendChild(data);
    }

    return row;
  }

  function copyDebugLog(response, feedbackEl) {
    const lines = [];
    lines.push("NoBait debug log");
    const head = [];
    head.push("ok=" + (response.ok ? "true" : "false"));
    if (response.error) head.push("error=" + response.error);
    if (response.contentStatus) head.push("contentStatus=" + response.contentStatus);
    if (response.source) head.push("source=" + response.source);
    lines.push(head.join(" "));
    if (response.message) lines.push("message: " + response.message);
    if (response.summary) {
      const s = String(response.summary);
      lines.push("summary: " + (s.length > 400 ? s.substring(0, 400) + "..." : s));
    }
    lines.push("---");
    for (const entry of response.debug || []) {
      lines.push(
        "[" + (entry.t || 0) + "ms] " +
        (entry.stage || "?") + " " +
        (entry.status || "info") + ": " +
        (entry.detail || "")
      );
      if (entry.data && typeof entry.data === "object") {
        for (const key in entry.data) {
          const val = entry.data[key];
          if (val == null) continue;
          const str = typeof val === "object" ? JSON.stringify(val) : String(val);
          lines.push("    " + key + ": " + str);
        }
      }
    }
    const text = lines.join("\n");

    const flash = (label) => {
      const prev = feedbackEl.textContent;
      feedbackEl.textContent = label;
      setTimeout(() => { feedbackEl.textContent = prev; }, 1200);
    };

    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text)
          .then(() => flash("Copied!"))
          .catch(() => flash("Copy failed"));
        return;
      }
    } catch (_) { /* fall through */ }

    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;top:-1000px;left:-1000px;";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      flash("Copied!");
    } catch (_) {
      flash("Copy failed");
    }
  }
})();
