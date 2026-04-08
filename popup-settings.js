// NoBait - Popup Settings
// Manages trigger toggle checkboxes, the "Scrape this page" sidebar trigger,
// and persists trigger preferences to extension storage.

// --- Cross-browser API shim (Chrome uses `chrome`, Firefox exposes `browser`) ---
const api = (typeof browser !== "undefined") ? browser : chrome;

// --- Configuration ---
const STORAGE_KEY = "triggerSettings";
const SCRAPE_REQUEST_KEY = "scrapeRequest";
const STATUS_DISPLAY_MS = 1500;

// --- DOM references ---
const longClickEl = document.getElementById("trigger-longclick");
const shiftClickEl = document.getElementById("trigger-shiftclick");
const ctrlClickEl = document.getElementById("trigger-ctrlclick");
const statusEl = document.getElementById("status");
const scrapeBtn = document.getElementById("scrape-btn");
const scrapeStatusEl = document.getElementById("scrape-status");

// --- loadSettings: reads saved trigger state and updates checkboxes.
//     Uses Promise style so it works on both Chrome (MV3) and Firefox. ---
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

// --- saveSettings: writes current checkbox state to extension storage ---
function saveSettings() {
  const settings = {
    longClick: longClickEl.checked,
    shiftClick: shiftClickEl.checked,
    ctrlClick: ctrlClickEl.checked,
  };

  Promise.resolve(api.storage.sync.set({ [STORAGE_KEY]: settings }))
    .then(() => flashStatus("Saved!", "#22c55e"))
    .catch(() => flashStatus("Error saving", "#ef4444"));
}

// --- flashStatus: briefly shows a status message ---
function flashStatus(text, color) {
  statusEl.textContent = text;
  statusEl.style.color = color;
  statusEl.style.opacity = "1";
  setTimeout(() => {
    statusEl.style.opacity = "0";
  }, STATUS_DISPLAY_MS);
}

// --- onScrapeClick: queries the active tab, stashes its id+url under
//     SCRAPE_REQUEST_KEY (with a fresh timestamp so the sidebar can tell
//     this is a new request), then opens the sidebar. The sidebar reads
//     the request from storage on load and drives the rest. We rely on
//     storage rather than runtime messaging because the popup window
//     closes the moment the sidebar takes focus, killing any in-flight
//     message ports. ---
async function onScrapeClick() {
  scrapeBtn.disabled = true;
  flashScrapeStatus("Opening sidebar\u2026", "#6c47ff");

  try {
    const tabs = await Promise.resolve(api.tabs.query({ active: true, currentWindow: true }));
    const tab = tabs && tabs[0];
    if (!tab) {
      flashScrapeStatus("Could not find active tab.", "#ef4444");
      scrapeBtn.disabled = false;
      return;
    }

    // Stash the request so the sidebar picks it up on load
    await Promise.resolve(api.storage.local.set({
      [SCRAPE_REQUEST_KEY]: {
        ts: Date.now(),
        tabId: tab.id,
        url: tab.url || "",
        title: tab.title || "",
      },
    }));

    // Firefox: open the actual sidebar. This must be called from a user
    // gesture handler, which we are.
    if (api.sidebarAction && typeof api.sidebarAction.open === "function") {
      try {
        await Promise.resolve(api.sidebarAction.open());
        window.close();
        return;
      } catch (_) { /* fall through to window fallback */ }
    }

    // Chrome (no sidebar_action): open the sidebar UI in a small popup
    // window so the feature still works without a real sidebar.
    if (api.windows && typeof api.windows.create === "function") {
      try {
        await Promise.resolve(api.windows.create({
          url: api.runtime.getURL("sidebar.html"),
          type: "popup",
          width: 420,
          height: 720,
        }));
        window.close();
        return;
      } catch (_) { /* fall through */ }
    }

    flashScrapeStatus("Sidebar not supported in this browser.", "#ef4444");
    scrapeBtn.disabled = false;
  } catch (_) {
    flashScrapeStatus("Could not open sidebar.", "#ef4444");
    scrapeBtn.disabled = false;
  }
}

// --- flashScrapeStatus: brief inline status under the scrape button ---
function flashScrapeStatus(text, color) {
  if (!scrapeStatusEl) return;
  scrapeStatusEl.textContent = text;
  scrapeStatusEl.style.color = color;
  scrapeStatusEl.style.opacity = "1";
}

// --- Initialize ---
loadSettings();

// --- Save on any checkbox change ---
longClickEl.addEventListener("change", saveSettings);
shiftClickEl.addEventListener("change", saveSettings);
ctrlClickEl.addEventListener("change", saveSettings);

// --- Wire up scrape button ---
if (scrapeBtn) {
  scrapeBtn.addEventListener("click", onScrapeClick);
}
