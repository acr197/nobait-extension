// NoBait - Content Script
// Trigger detection (long-click, shift+click, ctrl+click), URL filtering, and popup UI

(function () {
  "use strict";

  // --- Cross-browser API shim (Chrome uses `chrome`, Firefox exposes `browser`) ---
  const api = (typeof browser !== "undefined") ? browser : chrome;

  // --- Configuration ---
  const LONG_PRESS_MS = 800;
  const MOVE_THRESHOLD = 10;
  const ANCHOR_TRAVERSAL_DEPTH = 10;
  const STORAGE_KEY = "triggerSettings";

  // --- Blocked domains: obvious non-news sites ---
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
    // Accounts / sign-in pages — must never surface personal info
    "accounts.google.com", "myaccount.google.com", "account.google.com",
    "mail.google.com", "calendar.google.com", "photos.google.com",
    "login.microsoftonline.com", "login.live.com", "account.microsoft.com",
    "appleid.apple.com", "account.apple.com", "id.atlassian.com",
  ];

  // --- Patterns used to scrub personal info from the sidebar list.
  //     We never want to surface things like the user's email address,
  //     "Google Account: John Doe", or "Sign in" links as if they were
  //     news headlines. ---
  const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
  const ACCOUNT_HEADLINE_REGEX =
    /^(?:google account|your account|my account|account settings|sign\s*in|sign\s*out|log\s*in|log\s*out|switch account|manage account|profile)\b/i;

  // --- Blocked search paths ---
  const BLOCKED_SEARCH_PATHS = [
    { host: "google.com", path: "/search" },
    { host: "bing.com", path: "/search" },
    { host: "duckduckgo.com", path: "/" },
  ];

  // --- State ---
  let pressTimer = null;
  let startX = 0;
  let startY = 0;
  let activePopupHost = null;
  let longPressTriggered = false;
  let modifierHandledViaPointerUp = false;

  // --- Trigger enable flags (loaded from storage) ---
  let enableLongClick = true;
  let enableShiftClick = true;
  let enableCtrlClick = false;

  // --- Load trigger settings from storage ---
  loadTriggerSettings();

  // --- Listen for storage changes so popup toggles take effect immediately ---
  api.storage.onChanged.addListener(onStorageChanged);

  // --- Listen for messages from the sidebar. Two types:
  //       GET_ARTICLE_LINKS  → scan page for headlines (returns list)
  //       SHOW_POPUP_AT      → render the in-page summary popup at (x, y)
  //     Uses both sendResponse and a Promise return for Chrome/Firefox parity. ---
  api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;

    if (msg.type === "GET_ARTICLE_LINKS") {
      let result;
      try {
        const links = collectArticleLinks();
        result = { ok: true, links, pageTitle: document.title, pageUrl: location.href };
      } catch (err) {
        result = { ok: false, error: String(err && err.message || err) };
      }
      try { sendResponse(result); } catch (_) { /* channel may be closed */ }
      return Promise.resolve(result);
    }

    if (msg.type === "SHOW_POPUP_AT") {
      let result;
      try {
        const url = msg.url;
        const headline = msg.headline;
        if (!url || !headline) {
          result = { ok: false, error: "missing_args" };
        } else {
          // Clamp the requested position to the current viewport so a
          // stale Y from the sidebar (after the page scrolled) still lands
          // somewhere visible. The popup already does its own clamping,
          // but do a conservative pre-clamp here too.
          const x = typeof msg.x === "number" ? msg.x : 20;
          let y = typeof msg.y === "number" ? msg.y : 120;
          if (y < 20) y = 20;
          if (y > window.innerHeight - 20) y = window.innerHeight - 20;
          showPopup(url, headline, x, y);
          result = { ok: true };
        }
      } catch (err) {
        result = { ok: false, error: String(err && err.message || err) };
      }
      try { sendResponse(result); } catch (_) { /* channel may be closed */ }
      return Promise.resolve(result);
    }
  });

  // --- Event listeners ---
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("pointermove", onPointerMove, true);
  document.addEventListener("pointerup", onPointerUp, true);
  document.addEventListener("pointercancel", onPointerCancel, true);
  document.addEventListener("click", onClickCapture, true);

  // =========================================================================
  // SETTINGS
  // =========================================================================

  // --- loadTriggerSettings: reads saved trigger preferences from extension storage.
  //     Uses Promise style so it works on both Chrome (MV3 returns Promises) and
  //     Firefox (browser.* always returns Promises) ---
  function loadTriggerSettings() {
    try {
      const p = api.storage.sync.get([STORAGE_KEY]);
      Promise.resolve(p).then((result) => {
        const s = result && result[STORAGE_KEY];
        if (!s) return;
        if (typeof s.longClick === "boolean") enableLongClick = s.longClick;
        if (typeof s.shiftClick === "boolean") enableShiftClick = s.shiftClick;
        if (typeof s.ctrlClick === "boolean") enableCtrlClick = s.ctrlClick;
      }).catch(() => { /* ignore */ });
    } catch (_) { /* ignore */ }
  }

  // --- onStorageChanged: updates trigger flags when user toggles settings ---
  function onStorageChanged(changes) {
    if (!changes[STORAGE_KEY]) return;
    const s = changes[STORAGE_KEY].newValue;
    if (!s) return;
    if (typeof s.longClick === "boolean") enableLongClick = s.longClick;
    if (typeof s.shiftClick === "boolean") enableShiftClick = s.shiftClick;
    if (typeof s.ctrlClick === "boolean") enableCtrlClick = s.ctrlClick;
  }

  // =========================================================================
  // TRIGGER DETECTION
  // =========================================================================

  // --- onPointerDown: starts the long-press timer on primary button ---
  function onPointerDown(e) {
    if (e.button !== 0) return;
    cancelPress();

    if (!enableLongClick) return;

    const anchor = findAnchor(e.target, e);
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

  // --- onPointerUp: cancels long-press if released before threshold,
  //     and handles modifier-click triggers via pointerup (works on sites
  //     like Google News that intercept/eat click events) ---
  function onPointerUp(e) {
    if (pressTimer) {
      cancelPress();
    }

    // Handle shift+click and ctrl+click via pointerup so it works even when
    // the site eats the subsequent click event (e.g. Google News)
    if (e.button === 0 && !longPressTriggered) {
      const wantShift = e.shiftKey && !e.ctrlKey && enableShiftClick;
      const wantCtrl = e.ctrlKey && !e.shiftKey && enableCtrlClick;
      if (wantShift || wantCtrl) {
        const anchor = findAnchor(e.target, e);
        if (anchor) {
          const href = resolveHref(anchor);
          if (href) {
            modifierHandledViaPointerUp = true;
            triggerPopup(anchor, href, e.clientX, e.clientY);
            return;
          }
        }
      }
    }

    // Safety net: reset flags after 300ms in case the click event
    // never fires (Google News intercepts it), preventing all subsequent clicks
    // from being silently eaten
    setTimeout(() => {
      longPressTriggered = false;
      modifierHandledViaPointerUp = false;
    }, 300);
  }

  // --- onPointerCancel: cleanup on pointer interruption ---
  function onPointerCancel() {
    cancelPress();
  }

  // --- onClickCapture: suppresses clicks after triggers, closes popup on outside click ---
  function onClickCapture(e) {
    // Suppress the click that fires after a successful long-press
    if (longPressTriggered) {
      longPressTriggered = false;
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }

    // Suppress the click that fires after a modifier-click handled via pointerup
    if (modifierHandledViaPointerUp) {
      modifierHandledViaPointerUp = false;
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

  // --- triggerPopup: validates the URL, sets suppress flag, and opens the popup ---
  function triggerPopup(anchor, href, x, y) {
    if (isBlockedUrl(href)) return;

    longPressTriggered = true;

    // Try to unwrap Google News redirect URLs
    const finalHref = unwrapGoogleNewsUrl(anchor, href);

    const headline = extractHeadline(anchor);
    if (!headline) {
      longPressTriggered = false;
      return;
    }

    showPopup(finalHref, headline, x, y);
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

  // --- findAnchor: walks up the DOM (using composedPath to pierce Shadow DOM)
  //     to find the nearest <a> element ---
  function findAnchor(el, event) {
    // Use composedPath if available (pierces Shadow DOM boundaries)
    if (event && typeof event.composedPath === "function") {
      const path = event.composedPath();
      for (let i = 0; i < Math.min(path.length, ANCHOR_TRAVERSAL_DEPTH); i++) {
        const node = path[i];
        if (node.tagName === "A" && node.href) return node;
      }
      return null;
    }
    // Fallback: regular parentElement walk
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

  // --- Material Icons ligature regex. Sites like Google News render inline
  //     icons with <i class="material-icons">chevron_right</i> inside or next
  //     to the article's anchor, which means the ligature name bleeds into
  //     the anchor's textContent. Strip any whole-word occurrence so headlines
  //     don't end with "... chevron_right". ---
  const ICON_LIGATURE_REGEX = /\b(?:chevron_right|chevron_left|chevron_up|chevron_down|arrow_forward|arrow_back|arrow_upward|arrow_downward|keyboard_arrow_right|keyboard_arrow_left|keyboard_arrow_up|keyboard_arrow_down|open_in_new|open_in_browser|expand_more|expand_less|more_vert|more_horiz|play_arrow|launch|fiber_manual_record|radio_button_unchecked)\b/gi;

  // --- cleanHeadlineText: strips icon ligature names and collapses whitespace ---
  function cleanHeadlineText(text) {
    if (!text) return text;
    return text.replace(ICON_LIGATURE_REGEX, " ").replace(/\s+/g, " ").trim();
  }

  // --- extractHeadline: gets meaningful text from the anchor, falling back
  //     to nearby article/heading context for sites like Google News ---
  function extractHeadline(anchor) {
    let text = anchor.textContent.trim();

    // Fall back to aria-label or title for image-only links
    if (text.length < 5) {
      text = anchor.getAttribute("aria-label") || anchor.title || text;
    }

    // Fall back to parent <article> headings (Google News, news aggregators)
    if (!text || text.length < 5) {
      const article = anchor.closest("article, [role='article'], c-wiz");
      if (article) {
        const heading = article.querySelector("h1, h2, h3, h4, [role='heading']");
        if (heading) {
          const headingText = heading.textContent.trim();
          if (headingText.length >= 5) text = headingText;
        }
        // If still no heading, try any <a> with substantial text
        if (!text || text.length < 5) {
          for (const link of article.querySelectorAll("a")) {
            const linkText = link.textContent.trim();
            if (linkText.length >= 10) { text = linkText; break; }
          }
        }
      }
    }

    // Scrub icon ligatures and collapse whitespace
    text = cleanHeadlineText(text);
    return text || null;
  }

  // =========================================================================
  // ARTICLE LINK COLLECTION (for sidebar)
  // =========================================================================

  // --- collectArticleLinks: scans the current page for article-like links.
  //     Returns an array of { url, headline } in document order, deduped. ---
  function collectArticleLinks() {
    const anchors = document.querySelectorAll("a[href]");
    const seen = new Set();
    const results = [];
    const currentHost = location.hostname.toLowerCase();

    for (const anchor of anchors) {
      // Skip hidden links
      if (anchor.offsetParent === null && anchor.getClientRects().length === 0) continue;

      const href = resolveHref(anchor);
      if (!href) continue;

      // Skip in-page anchors and self-links to the current URL
      if (href.split("#")[0] === location.href.split("#")[0]) continue;

      // Skip blocked (social, video, shopping, etc.)
      if (isBlockedUrl(href)) continue;

      // Skip obvious same-host nav/utility links (home, about, etc.)
      // but keep article links on the current domain
      let parsed;
      try { parsed = new URL(href); } catch (_) { continue; }
      const sameHost = parsed.hostname.toLowerCase() === currentHost;
      if (sameHost) {
        const path = parsed.pathname.toLowerCase();
        // Skip root and very short paths (likely nav)
        if (path === "/" || path === "" || path.length < 6) continue;
        // Skip common utility paths
        if (/^\/(about|contact|privacy|terms|login|signin|signup|register|subscribe|newsletter|search|tag|tags|category|categories|author|authors|archive|archives|rss|feed|sitemap)(\/|$)/.test(path)) continue;
      }

      const headline = extractHeadline(anchor);
      if (!headline) continue;
      const clean = headline.trim();
      // Require a reasonably substantial headline
      if (clean.length < 20) continue;
      if (clean.split(/\s+/).length < 4) continue;

      // Privacy guard: never surface the user's email address, account
      // greetings, or sign-in links — these show up as anchor text on sites
      // like Google News and would be jarring to see in the sidebar.
      if (EMAIL_REGEX.test(clean)) continue;
      if (ACCOUNT_HEADLINE_REGEX.test(clean)) continue;

      // Try to unwrap Google News wrapper URLs
      const finalUrl = unwrapGoogleNewsUrl(anchor, href) || href;

      // Dedupe on final URL + headline
      const key = finalUrl + "|" + clean.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      let sourceHost = "";
      try { sourceHost = new URL(finalUrl).hostname.replace(/^www\./, ""); } catch (_) { /* ignore */ }

      results.push({ url: finalUrl, headline: clean, source: sourceHost });

      // Reasonable cap so huge pages don't overwhelm the sidebar
      if (results.length >= 200) break;
    }

    return results;
  }

  // =========================================================================
  // URL FILTERING
  // =========================================================================

  // --- isBlockedUrl: returns true if the URL is on the blocklist ---
  function isBlockedUrl(href) {
    let url;
    try {
      url = new URL(href);
    } catch (_) {
      return true;
    }

    const hostname = url.hostname.toLowerCase();

    // Check blocked domains
    for (const domain of BLOCKED_DOMAINS) {
      if (hostname === domain || hostname.endsWith("." + domain)) return true;
    }

    // Check blocked search paths
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

  // --- unwrapGoogleNewsUrl: extracts the real destination from Google News wrapper links ---
  function unwrapGoogleNewsUrl(anchor, href) {
    let url;
    try {
      url = new URL(href);
    } catch (_) {
      return href;
    }

    const hostname = url.hostname.toLowerCase();

    // Only process news.google.com links
    if (hostname !== "news.google.com" && !hostname.endsWith(".news.google.com")) {
      return href;
    }

    // Try data-n-au, data-href, or data-url on the anchor itself
    const directUrl = extractDataUrl(anchor);
    if (directUrl) return directUrl;

    // Walk up to parent <article> / <c-wiz> and search for data-n-au on any element
    let parent = anchor.parentElement;
    for (let i = 0; i < 6 && parent && parent !== document.body; i++) {
      const parentUrl = extractDataUrl(parent);
      if (parentUrl) return parentUrl;

      if (parent.tagName === "ARTICLE" || parent.tagName === "C-WIZ") {
        // Search within this container for any link with data-n-au
        const dataLink = parent.querySelector("a[data-n-au]");
        if (dataLink) {
          const au = extractDataUrl(dataLink);
          if (au) return au;
        }
        break;
      }
      parent = parent.parentElement;
    }

    // Try extracting from the URL query params (e.g. ?url=... or ?q=...)
    for (const key of ["url", "q", "dest"]) {
      const param = url.searchParams.get(key);
      if (param) {
        try {
          const paramUrl = new URL(param);
          if (paramUrl.protocol === "http:" || paramUrl.protocol === "https:") {
            return paramUrl.href;
          }
        } catch (_) {
          // not a valid URL, skip
        }
      }
    }

    // Last resort: convert /articles/... to /rss/articles/... for server-side redirect
    if (url.pathname.startsWith("/articles/") || url.pathname.startsWith("/read/")) {
      return url.href.replace(
        /news\.google\.com\/(articles|read)\//,
        "news.google.com/rss/articles/"
      );
    }

    // Could not unwrap — return original and let background.js follow the redirect
    return href;
  }

  // --- extractDataUrl: checks an element for data-n-au, data-href, or data-url ---
  function extractDataUrl(el) {
    for (const attr of ["data-n-au", "data-href", "data-url"]) {
      const val = el.getAttribute ? el.getAttribute(attr) : null;
      if (val) {
        try {
          const u = new URL(val);
          if (u.protocol === "http:" || u.protocol === "https:") return u.href;
        } catch (_) { /* skip */ }
      }
    }
    return null;
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

    // Request summary from background. Use Promise style so the same code path
    // works in Chrome (MV3 returns Promises when no callback is given) and
    // Firefox (browser.runtime.sendMessage always returns a Promise).
    Promise.resolve(api.runtime.sendMessage({ type: "SUMMARIZE", url, headline }))
      .then((response) => {
        if (!response) {
          renderError(popup, spinnerWrap, "fetch_failed", "No response from extension.", headline);
          return;
        }
        if (response.ok) {
          renderSummary(popup, spinnerWrap, response.summary);
        } else {
          renderError(popup, spinnerWrap, response.error, response.message, headline);
        }
      })
      .catch(() => {
        renderError(popup, spinnerWrap, "fetch_failed", "Extension error. Try again.", headline);
      });
  }

  // --- Rotating tongue-in-cheek lines shown under the PURE CLICKBAIT banner. ---
  const CLICKBAIT_QUIPS = [
    "Saved you the click.",
    "Not even worth lifting a finger.",
    "All bait, no meal.",
    "Journalistic rickroll.",
    "Hook set, line empty.",
    "You're welcome.",
    "The article's soul: empty.",
    "Attention economy 1, your time 0.",
  ];

  // --- parseClickbaitVerdict: returns the snarky one-liner if the AI's
  //     response starts with the CLICKBAIT: sentinel, otherwise null. ---
  function parseClickbaitVerdict(summary) {
    if (!summary) return null;
    const m = summary.match(/^\s*CLICKBAIT\s*[:\-]\s*(.*)$/is);
    if (!m) return null;
    return (m[1] || "").trim();
  }

  // --- renderSummary: replaces spinner with the AI summary text ---
  function renderSummary(popup, spinnerWrap, summary) {
    if (!activePopupHost) return;

    const body = document.createElement("div");
    body.className = "nobait-body";

    const verdict = parseClickbaitVerdict(summary);
    if (verdict !== null) {
      body.classList.add("nobait-clickbait-body");

      const banner = document.createElement("div");
      banner.className = "nobait-clickbait-banner";
      banner.textContent = "PURE CLICKBAIT";
      body.appendChild(banner);

      if (verdict) {
        const roast = document.createElement("div");
        roast.className = "nobait-clickbait-roast";
        roast.textContent = verdict;
        body.appendChild(roast);
      }

      const quip = document.createElement("div");
      quip.className = "nobait-clickbait-quip";
      quip.textContent = CLICKBAIT_QUIPS[Math.floor(Math.random() * CLICKBAIT_QUIPS.length)];
      body.appendChild(quip);
    } else {
      const text = document.createElement("div");
      text.className = "nobait-summary";
      text.textContent = summary;
      body.appendChild(text);
    }

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
      .nobait-clickbait-body {
        display: flex;
        flex-direction: column;
        align-items: center;
        text-align: center;
        gap: 8px;
        padding: 18px 16px 16px;
      }
      .nobait-clickbait-banner {
        font-size: 19px;
        font-weight: 900;
        letter-spacing: 0.06em;
        color: #dc2626;
        text-transform: uppercase;
        text-shadow: 0 1px 0 rgba(220, 38, 38, 0.12);
        animation: nobait-clickbait-pulse 1.6s ease-in-out infinite;
      }
      @keyframes nobait-clickbait-pulse {
        0%, 100% { transform: scale(1); }
        50%      { transform: scale(1.035); }
      }
      .nobait-clickbait-roast {
        font-size: 13px;
        color: #1a1a1a;
        line-height: 1.45;
        max-width: 300px;
      }
      .nobait-clickbait-quip {
        margin-top: 4px;
        padding-top: 8px;
        border-top: 1px dashed #eee;
        font-size: 11.5px;
        font-style: italic;
        color: #9a9aa6;
        width: 100%;
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
