// NoBait - Popup Settings
// Manages trigger toggle checkboxes and persists to extension storage

// --- Cross-browser API shim (Chrome uses `chrome`, Firefox exposes `browser`) ---
const api = (typeof browser !== "undefined") ? browser : chrome;

// --- Configuration ---
const STORAGE_KEY = "triggerSettings";
const STATUS_DISPLAY_MS = 1500;

// --- DOM references ---
const longClickEl = document.getElementById("trigger-longclick");
const shiftClickEl = document.getElementById("trigger-shiftclick");
const ctrlClickEl = document.getElementById("trigger-ctrlclick");
const statusEl = document.getElementById("status");

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

// --- Initialize ---
loadSettings();

// --- Save on any checkbox change ---
longClickEl.addEventListener("change", saveSettings);
shiftClickEl.addEventListener("change", saveSettings);
ctrlClickEl.addEventListener("change", saveSettings);
