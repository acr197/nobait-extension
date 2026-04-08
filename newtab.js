// NoBait - New Tab Page
// Renders a headline feed and search box on the overridden new tab. Each card
// uses the same DOM shape (article > a > h3.title) that NoBait's content.js
// already recognizes, so long-click / shift+click / ctrl+click just work.

(function () {
  "use strict";

  // --- Cross-browser API shim (Chrome uses `chrome`, Firefox exposes `browser`) ---
  const api = (typeof browser !== "undefined") ? browser : chrome;

  // --- Search submission (DuckDuckGo — privacy-friendly default) ---
  const searchForm = document.getElementById("search-form");
  const searchInput = document.getElementById("search-input");
  if (searchForm && searchInput) {
    searchForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const q = searchInput.value.trim();
      if (!q) return;
      window.location.href = "https://duckduckgo.com/?q=" + encodeURIComponent(q);
    });
  }

  // --- Feed rendering ---
  const feedGrid = document.getElementById("feed-grid");

  // --- Fallback headlines shown when the live feed can't be fetched. These
  //     are deliberately generic so they stay useful when offline and they
  //     all point at real, stable homepages so the AI proxy can still return
  //     something meaningful via headline-only mode. ---
  const FALLBACK_ITEMS = [
    {
      title: "What's actually driving today's top market story?",
      url: "https://www.bloomberg.com/",
      source: "Bloomberg",
    },
    {
      title: "The real science behind the latest health headline",
      url: "https://www.reuters.com/business/healthcare-pharmaceuticals/",
      source: "Reuters",
    },
    {
      title: "Who really won the latest political showdown?",
      url: "https://apnews.com/hub/politics",
      source: "AP News",
    },
    {
      title: "The truth about the tech product everyone's arguing about",
      url: "https://www.theverge.com/tech",
      source: "The Verge",
    },
    {
      title: "What the viral sports moment actually means",
      url: "https://www.bbc.com/sport",
      source: "BBC Sport",
    },
    {
      title: "The story the climate headline isn't telling you",
      url: "https://www.theguardian.com/environment",
      source: "The Guardian",
    },
    {
      title: "What's really behind the latest space discovery?",
      url: "https://www.nasa.gov/news/",
      source: "NASA",
    },
    {
      title: "The real answer behind this week's trending business story",
      url: "https://www.ft.com/",
      source: "Financial Times",
    },
  ];

  // --- render: wipes the grid and inserts a card per item. Only the <h3>
  //     title sits inside the <a class="ds-card-link">, so content.js's
  //     extractHeadline (which reads anchor.textContent) returns a clean
  //     headline without the publisher label or the UI hint polluting it.
  //     The outer shape (<article class="ds-card"> + h3.title inside an
  //     <a class="ds-card-link">) still mirrors Firefox's own Discovery
  //     Stream markup. ---
  function render(items) {
    if (!feedGrid) return;
    feedGrid.textContent = "";

    for (const item of items) {
      if (!item || !item.title || !item.url) continue;

      const card = document.createElement("article");
      card.className = "feed-card ds-card sections-card-ui";

      if (item.source) {
        const source = document.createElement("span");
        source.className = "feed-card-source";
        source.textContent = item.source;
        card.appendChild(source);
      }

      const link = document.createElement("a");
      link.className = "ds-card-link";
      link.href = item.url;
      link.rel = "noopener";
      link.setAttribute("aria-label", item.title);

      const title = document.createElement("h3");
      title.className = "title clamp";
      title.textContent = item.title;
      link.appendChild(title);

      card.appendChild(link);

      const hint = document.createElement("span");
      hint.className = "feed-card-hint";
      hint.textContent = "Long-click for the real story";
      card.appendChild(hint);

      feedGrid.appendChild(card);
    }
  }

  // --- loadFeed: asks background.js for a live feed. Background owns the
  //     network call so CORS/host-permission details stay in one place. If
  //     anything goes wrong we silently fall back to the curated list. ---
  function loadFeed() {
    let settled = false;
    const fallbackTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      render(FALLBACK_ITEMS);
    }, 4000);

    Promise.resolve(api.runtime.sendMessage({ type: "FETCH_FEED" }))
      .then((response) => {
        if (settled) return;
        settled = true;
        clearTimeout(fallbackTimer);

        if (response && response.ok && Array.isArray(response.items) && response.items.length > 0) {
          render(response.items);
        } else {
          render(FALLBACK_ITEMS);
        }
      })
      .catch(() => {
        if (settled) return;
        settled = true;
        clearTimeout(fallbackTimer);
        render(FALLBACK_ITEMS);
      });
  }

  loadFeed();
})();
