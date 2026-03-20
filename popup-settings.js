// NoBait - Popup Settings

const proxyInput = document.getElementById("proxy-url");
const saveBtn = document.getElementById("save-btn");
const statusEl = document.getElementById("status");

// Load saved proxy URL
chrome.storage.sync.get(["proxyUrl"], (result) => {
  if (result.proxyUrl) {
    proxyInput.value = result.proxyUrl;
  }
});

saveBtn.addEventListener("click", () => {
  const url = proxyInput.value.trim();
  if (url && !isValidUrl(url)) {
    flashStatus("Invalid URL", "#ef4444");
    return;
  }

  chrome.storage.sync.set({ proxyUrl: url }, () => {
    flashStatus("Saved!", "#22c55e");
  });
});

function isValidUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

function flashStatus(text, color) {
  statusEl.textContent = text;
  statusEl.style.color = color;
  statusEl.style.opacity = "1";
  setTimeout(() => {
    statusEl.style.opacity = "0";
  }, 2000);
}
