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
  const unreadableEl = document.getElementById("sb-unreadable");
  const loadingEl = document.getElementById("sb-loading");

  const longClickEl = document.getElementById("sb-trigger-longclick");
  const shiftClickEl = document.getElementById("sb-trigger-shiftclick");
  const ctrlClickEl = document.getElementById("sb-trigger-ctrlclick");

  const modalEl = document.getElementById("sb-modal");
  const modalBackdrop = modalEl.querySelector(".sb-modal-backdrop");
  const modalCloseBtn = document.getElementById("sb-modal-close");
  const modalHeadlineEl = document.getElementById("sb-modal-headline");
  const modalBodyEl = document.getElementById("sb-modal-body");
  const modalOpenLink = document.getElementById("sb-modal-open");

  // --- Request sequencing: ignore summaries that arrive after the user
  //     closed/reopened the modal for a different article. ---
  let activeRequestId = 0;

  // --- RSS-fallback mode: true when the active tab is a privileged page
  //     (about:home, about:newtab, etc.) and we showed Google News top
  //     stories instead. In that mode the content script isn't available,
  //     so clicks must fall back to the inline sidebar modal. ---
  let inRssMode = false;

  // =========================================================================
  // INITIALIZATION
  // =========================================================================

  loadSettings();
  attachEventListeners();
  scanActiveTab();

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

    settingsToggleBtn.addEventListener("click", () => {
      settingsPanel.classList.toggle("hidden");
    });

    longClickEl.addEventListener("change", saveSettings);
    shiftClickEl.addEventListener("change", saveSettings);
    ctrlClickEl.addEventListener("change", saveSettings);

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
      })
      .catch(() => { /* ignore */ });
  }

  function saveSettings() {
    const settings = {
      longClick: longClickEl.checked,
      shiftClick: shiftClickEl.checked,
      ctrlClick: ctrlClickEl.checked,
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
    inRssMode = false;

    let tab;
    try {
      tab = await getActiveTab();
    } catch (_) {
      await showUnreadableOrFallback(null);
      return;
    }
    if (!tab) {
      await showUnreadableOrFallback(null);
      return;
    }

    // Update the page info header
    pageTitleEl.textContent = tab.title || "(untitled)";
    pageMetaEl.textContent = "";

    // Privileged pages (about:, chrome:, moz-extension:) can't be scanned —
    // fall back to Google News top stories so the sidebar isn't empty.
    if (!isReadableUrl(tab.url)) {
      await showUnreadableOrFallback(tab);
      return;
    }

    // Ask the content script to collect article links
    let response;
    try {
      response = await Promise.resolve(
        api.tabs.sendMessage(tab.id, { type: "GET_ARTICLE_LINKS" })
      );
    } catch (err) {
      // Content script not present (file://, privileged page, or injection blocked)
      await showUnreadableOrFallback(tab);
      return;
    }

    if (!response || !response.ok || !Array.isArray(response.links)) {
      await showUnreadableOrFallback(tab);
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

  // --- showUnreadableOrFallback: when we can't read the active tab
  //     (privileged page like about:home, or content script unavailable),
  //     fetch Google News top stories through background.js and render
  //     them instead. Falls back to the "can't read" state if that fails. ---
  async function showUnreadableOrFallback(tab) {
    let trending;
    try {
      const resp = await Promise.resolve(
        api.runtime.sendMessage({ type: "FETCH_TRENDING_NEWS" })
      );
      if (resp && resp.ok && Array.isArray(resp.links) && resp.links.length > 0) {
        trending = resp.links;
      }
    } catch (_) { /* ignore, fall through */ }

    if (!trending) {
      showUnreadable();
      return;
    }

    inRssMode = true;
    pageTitleEl.textContent = "Top headlines";
    pageMetaEl.textContent = trending.length + " articles · Google News";
    renderLinks(trending);
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
    // itself, anchored near the cursor so the summary surfaces next to wherever
    // the user clicked. Falls back to the inline sidebar modal if the content
    // script isn't reachable (privileged page / RSS fallback).
    if (!inRssMode) {
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
    }

    openSummaryInModal(link);
  }

  async function openSummaryInModal(link) {
    const requestId = ++activeRequestId;

    modalHeadlineEl.textContent = link.headline;
    modalOpenLink.href = link.url;
    modalBodyEl.innerHTML = "";
    const loading = document.createElement("div");
    loading.className = "sb-modal-loading";
    loading.innerHTML = '<div class="sb-spinner"></div><div class="sb-modal-loading-text">Analyzing article\u2026</div>';
    modalBodyEl.appendChild(loading);

    openModal();

    let response;
    try {
      response = await Promise.resolve(
        api.runtime.sendMessage({ type: "SUMMARIZE", url: link.url, headline: link.headline })
      );
    } catch (err) {
      if (requestId !== activeRequestId) return;
      renderError("ai_error", "Extension error. Try again.", link.headline);
      return;
    }

    if (requestId !== activeRequestId) return;

    if (!response) {
      renderError("ai_error", "No response from extension.", link.headline);
      return;
    }
    if (response.ok) {
      renderSummary(response.summary);
    } else {
      renderError(response.error, response.message, link.headline);
    }
  }

  function renderSummary(summary) {
    modalBodyEl.innerHTML = "";
    const div = document.createElement("div");
    div.className = "sb-modal-summary";
    div.textContent = summary;
    modalBodyEl.appendChild(div);
  }

  function renderError(errorType, message, headline) {
    modalBodyEl.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "sb-modal-error";

    const icon = document.createElement("div");
    icon.className = "sb-modal-error-icon";
    if (errorType === "paywall") icon.textContent = "\uD83D\uDD12";
    else if (errorType === "blocked") icon.textContent = "\uD83D\uDEAB";
    else icon.textContent = "\u26A0\uFE0F";
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
  }
})();
