// NoBait - Sidebar Logic
// Reads the most recent scrape request from storage, asks background.js to
// pull the page's news links (or the Merino feed for about:newtab), then
// fetches a NoBait summary for each link with limited concurrency.

(function () {
  "use strict";

  // --- Cross-browser API shim ---
  const api = (typeof browser !== "undefined") ? browser : chrome;

  // --- Configuration ---
  const SCRAPE_REQUEST_KEY = "scrapeRequest";
  const REQUEST_FRESH_MS = 60 * 1000; // accept requests opened in the last minute
  const SUMMARY_CONCURRENCY = 3;
  const MAX_ITEMS = 12;

  // --- DOM ---
  const sourceLineEl = document.getElementById("source-line");
  const resultsEl = document.getElementById("results");
  const refreshBtn = document.getElementById("refresh-btn");

  // --- State: track the active scrape so a new one can cancel it ---
  let activeRunId = 0;

  refreshBtn.addEventListener("click", () => {
    runFromStorage();
  });

  // --- On load: pick up whatever request the popup just stashed ---
  runFromStorage();

  // --- React when the popup stashes a new request while the sidebar is
  //     already open. The popup writes a fresh timestamp every click, so a
  //     change event with a different ts means "scan again". ---
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[SCRAPE_REQUEST_KEY]) return;
    runFromStorage();
  });

  // =========================================================================
  // ENTRY POINT
  // =========================================================================

  function runFromStorage() {
    Promise.resolve(api.storage.local.get([SCRAPE_REQUEST_KEY]))
      .then((res) => {
        const req = res && res[SCRAPE_REQUEST_KEY];
        if (!req || !req.tabId) {
          showWaiting();
          return;
        }
        if (Date.now() - (req.ts || 0) > REQUEST_FRESH_MS) {
          // Old request from a previous popup session - ignore until the
          // user clicks Refresh, which will re-read it anyway.
          showWaiting();
          return;
        }
        scrapeAndRender(req);
      })
      .catch(() => showError("Could not read scrape request."));
  }

  // =========================================================================
  // SCRAPE + RENDER PIPELINE
  // =========================================================================

  async function scrapeAndRender(req) {
    const runId = ++activeRunId;
    refreshBtn.disabled = true;

    showSource(req);
    showLoading("Scanning page for headlines\u2026");

    let response;
    try {
      response = await Promise.resolve(api.runtime.sendMessage({
        type: "SCRAPE_PAGE",
        tabId: req.tabId,
        url: req.url || "",
      }));
    } catch (_) {
      if (runId !== activeRunId) return;
      showError("Could not reach the background script.");
      refreshBtn.disabled = false;
      return;
    }

    if (runId !== activeRunId) return;

    if (!response || !response.ok || !Array.isArray(response.items) || response.items.length === 0) {
      const msg = (response && response.message) || "No news article links found on this page.";
      showError(msg);
      refreshBtn.disabled = false;
      return;
    }

    const items = response.items.slice(0, MAX_ITEMS);
    const cards = renderCards(items);
    refreshBtn.disabled = false;

    // Fetch summaries in parallel with bounded concurrency
    fetchSummariesWithLimit(items, cards, runId);
  }

  // --- renderCards: builds a card per item with a placeholder summary,
  //     returns the array of card refs so summaries can fill them in. ---
  function renderCards(items) {
    resultsEl.textContent = "";
    const cards = [];

    for (const item of items) {
      const card = document.createElement("article");
      card.className = "card";

      if (item.source) {
        const src = document.createElement("div");
        src.className = "card-source";
        src.textContent = item.source;
        card.appendChild(src);
      }

      const headline = document.createElement("a");
      headline.className = "card-headline";
      headline.href = item.url;
      headline.target = "_blank";
      headline.rel = "noopener noreferrer";
      headline.textContent = item.title;
      card.appendChild(headline);

      const summary = document.createElement("div");
      summary.className = "card-summary placeholder";
      const spinner = document.createElement("div");
      spinner.className = "spinner";
      summary.appendChild(spinner);
      const label = document.createElement("span");
      label.textContent = "Analyzing\u2026";
      summary.appendChild(label);
      card.appendChild(summary);

      resultsEl.appendChild(card);
      cards.push({ item, card, summaryEl: summary });
    }

    return cards;
  }

  // --- fetchSummariesWithLimit: starts up to SUMMARY_CONCURRENCY summary
  //     requests at once and refills as each one finishes. Each finished
  //     summary updates its card in place. The runId guard prevents a
  //     stale run from clobbering a newer Refresh. ---
  function fetchSummariesWithLimit(items, cards, runId) {
    let nextIndex = 0;
    let inFlight = 0;

    function pump() {
      while (inFlight < SUMMARY_CONCURRENCY && nextIndex < items.length) {
        const idx = nextIndex++;
        const card = cards[idx];
        const item = items[idx];
        inFlight++;

        Promise.resolve(api.runtime.sendMessage({
          type: "SUMMARIZE",
          url: item.url,
          headline: item.title,
        }))
          .then((res) => {
            if (runId !== activeRunId) return;
            if (res && res.ok) {
              renderSummary(card, res.summary);
            } else {
              const msg = (res && res.message) || "Could not load this story.";
              renderSummaryError(card, item, msg);
            }
          })
          .catch(() => {
            if (runId !== activeRunId) return;
            renderSummaryError(card, item, "Extension error. Try again.");
          })
          .then(() => {
            inFlight--;
            if (runId === activeRunId) pump();
          });
      }
    }

    pump();
  }

  function renderSummary(card, text) {
    if (!card || !card.summaryEl) return;
    const div = document.createElement("div");
    div.className = "card-summary";
    div.textContent = text;
    card.summaryEl.replaceWith(div);
    card.summaryEl = div;
  }

  function renderSummaryError(card, item, message) {
    if (!card || !card.summaryEl) return;
    const wrap = document.createElement("div");
    wrap.className = "card-summary error";
    wrap.textContent = message;

    const fallback = document.createElement("button");
    fallback.type = "button";
    fallback.className = "fallback-btn";
    fallback.textContent = "Search Google";
    fallback.addEventListener("click", () => {
      const q = item.title || "";
      window.open("https://www.google.com/search?q=" + encodeURIComponent(q), "_blank", "noopener");
    });
    wrap.appendChild(document.createElement("br"));
    wrap.appendChild(fallback);

    card.summaryEl.replaceWith(wrap);
    card.summaryEl = wrap;
  }

  // =========================================================================
  // STATE HELPERS
  // =========================================================================

  function showWaiting() {
    sourceLineEl.textContent = "Waiting for a page to scan\u2026";
    resultsEl.textContent = "";
    const p = document.createElement("p");
    p.className = "loading";
    p.innerHTML =
      "Open the extension popup and click <strong>Scrape this page</strong> to start.";
    resultsEl.appendChild(p);
  }

  function showSource(req) {
    sourceLineEl.textContent = "";
    const label = document.createElement("strong");
    label.textContent = "Scanning: ";
    sourceLineEl.appendChild(label);
    sourceLineEl.appendChild(document.createTextNode(req.title || req.url || "active tab"));
  }

  function showLoading(msg) {
    resultsEl.textContent = "";
    const p = document.createElement("p");
    p.className = "loading";
    p.textContent = msg;
    resultsEl.appendChild(p);
  }

  function showError(msg) {
    resultsEl.textContent = "";
    const p = document.createElement("p");
    p.className = "error";
    p.textContent = msg;
    resultsEl.appendChild(p);
  }
})();
