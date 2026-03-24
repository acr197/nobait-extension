// NoBait - Popup Settings
// Manages trigger toggle checkboxes and persists to chrome.storage.sync

// --- Configuration ---
const STORAGE_KEY = "triggerSettings";
const STATUS_DISPLAY_MS = 1500;

// --- DOM references ---
const longClickEl = document.getElementById("trigger-longclick");
const shiftClickEl = document.getElementById("trigger-shiftclick");
const ctrlClickEl = document.getElementById("trigger-ctrlclick");
const statusEl = document.getElementById("status");

// --- loadSettings: reads saved trigger state and updates checkboxes ---
function loadSettings() {
  chrome.storage.sync.get([STORAGE_KEY], (result) => {
    if (chrome.runtime.lastError) return;
    const s = result[STORAGE_KEY];
    if (!s) return;
    if (typeof s.longClick === "boolean") longClickEl.checked = s.longClick;
    if (typeof s.shiftClick === "boolean") shiftClickEl.checked = s.shiftClick;
    if (typeof s.ctrlClick === "boolean") ctrlClickEl.checked = s.ctrlClick;
  });
}

// --- saveSettings: writes current checkbox state to chrome.storage ---
function saveSettings() {
  const settings = {
    longClick: longClickEl.checked,
    shiftClick: shiftClickEl.checked,
    ctrlClick: ctrlClickEl.checked,
  };

  chrome.storage.sync.set({ [STORAGE_KEY]: settings }, () => {
    if (chrome.runtime.lastError) {
      flashStatus("Error saving", "#ef4444");
      return;
    }
    flashStatus("Saved!", "#22c55e");
  });
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
