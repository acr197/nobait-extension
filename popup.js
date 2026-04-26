// popup.js — Settings UI for NoBait v2.
// Each fallback option has TWO controls:
//   - "Show button"  → if checked, the option appears as a button in the long-click tooltip
//   - "Auto"         → if checked, the option also runs automatically as part of the
//                      fallback chain on every long-click (and the in-tooltip button
//                      becomes a non-clickable green indicator showing it's running auto)
//
// Auto requires Show — checking Auto auto-checks Show; unchecking Show auto-unchecks Auto.

const FALLBACKS = [
  {
    key: "jsonLd",
    label: "Embedded body",
    description:
      "Many articles ship their full text in invisible page metadata for SEO crawlers — this reads it directly. Free, instant.",
    advanced:
      "Looks for <script type='application/ld+json'> blocks containing NewsArticle / Article schema with an articleBody field. Common on NYT, WaPo, BBC, Reuters, AP, and most modern CMS-published sites. Often returns the entire article body even on paywalled pages because the metadata is shipped to crawlers regardless of the user's subscription state.",
    defaultEnabled: true,
    defaultAuto: true,
  },
  {
    key: "metaDesc",
    label: "Page summary",
    description:
      "Falls back to the article's social-media preview text (2-3 sentences). Free; less detail than a full summary.",
    advanced:
      "Reads <meta name='description'>, <meta property='og:description'>, and <meta name='twitter:description'>. These are 2-3 sentence summaries the publisher writes for Google / Facebook / Twitter previews. Usually present even on paywalled articles. Quality varies — some publishers write substantive descriptions, others just paste the headline.",
    defaultEnabled: true,
    defaultAuto: true,
  },
  {
    key: "cookies",
    label: "Use my cookies",
    description:
      "Sends your existing browser session, so subscriber sites you're already logged into return the full article. Free.",
    advanced:
      "Adds credentials: 'include' to the fetch request. If you're logged into NYT, FT, Bloomberg, etc. in this browser, the publisher sees your session cookie and serves subscriber-tier HTML — the same content you'd see by clicking the link normally. Has no effect on sites you aren't logged into. Some publishers' anti-bot still blocks based on missing browser fingerprint, so this isn't a guaranteed bypass.",
    defaultEnabled: true,
    defaultAuto: true,
  },
  {
    key: "amp",
    label: "AMP version",
    description:
      "Tries the article's mobile/AMP URL — often free of paywalls and ads. Adds a few seconds; doesn't always exist.",
    advanced:
      "Many publishers serve a stripped-down 'AMP' (Accelerated Mobile Pages) version at /amp/ or ?amp=1. AMP pages usually have the full article body and no paywall because they're served to Google's mobile snippets. Hit rate ~30–50% depending on publisher. Tried via URL pattern transforms (/amp/<slug>, /<slug>/amp, ?amp=1).",
    defaultEnabled: true,
    defaultAuto: false,
  },
  {
    key: "twelveFt",
    label: "12ft.io proxy",
    description:
      "Routes the fetch through a public bypass service that pretends to be Googlebot. Slow; sometimes blocked; third-party.",
    advanced:
      "Sends the URL to https://12ft.io/<url> which fetches the article masquerading as Googlebot. Works on publishers that whitelist Googlebot for SEO. Quality is inconsistent because 12ft.io itself gets blocked by anti-bot from time to time. Privacy note: enabling this means the URL of every blocked article you long-press is sent to 12ft.io.",
    defaultEnabled: false,
    defaultAuto: false,
  },
  {
    key: "altSource",
    label: "Alternative source",
    description:
      "Searches for similar coverage from other publishers and summarizes one of those instead. Slow (5-15 sec); reliable when working.",
    advanced:
      "Hits Google News RSS search with the headline, walks up to 5 candidates from different publishers, skips any that are paywalled or blocked, and summarizes the first clean one. Falls through to DuckDuckGo HTML search if Google News yields nothing. Always cites which publisher it ended up using.",
    defaultEnabled: true,
    defaultAuto: false,
  },
  {
    key: "archive",
    label: "Wayback archive",
    description:
      "Looks up an archive.org snapshot and summarizes that. Slow; many recent articles aren't archived yet.",
    advanced:
      "Queries archive.org's Wayback availability API for the closest snapshot, then fetches the raw saved page (id_ modifier strips the Wayback toolbar wrapper) and summarizes it. Reliable for older articles, often misses recent ones (Wayback's index lags by hours/days). Not a true paywall bypass — only works for content Wayback captured publicly.",
    defaultEnabled: true,
    defaultAuto: false,
  },
];

const STORAGE_KEY = "nobaitSettings";

// Summary style options. Drives the AI prompt — Standard returns a 1-2
// sentence answer with context; Punchline returns the bare distilled
// answer in fragment form.
const STYLES = [
  {
    key: "standard",
    label: "Standard",
    description:
      "Short summary with context — 1-2 sentences. Good when you want the why and the how.",
    advanced:
      "Hard cap 220 chars. Asks the model for a substantive but brief summary that satisfies the headline's promise — answers the question, lists the items (up to 5), or gives the specific who/what/why. Default. Recommended for most users.",
  },
  {
    key: "punchline",
    label: "Punchline",
    description:
      "Just the distilled answer — fragments, names, lists. Skips all fluff.",
    advanced:
      "Hard cap 100 chars (typically <50). Forbids complete sentences, articles (the/a), and copulas (is/are). For a single answer returns just the noun phrase (e.g. 'Caramel Churro Sundae'). For lists returns numbered items inline ('1. X 2. Y 3. Z'). For questions returns a bare answer. Useful when you want the headline's payoff in one glance.",
  },
];

function defaultSettings() {
  const fallbacks = {};
  for (const f of FALLBACKS) {
    fallbacks[f.key] = { enabled: f.defaultEnabled, auto: f.defaultAuto };
  }
  return { summaryStyle: "standard", fallbacks };
}

// Normalizes a stored fallback entry into { enabled, auto }. Handles legacy
// formats where the value was a bare boolean (= "auto-run") and the option
// was implicitly always enabled in the tooltip.
function normalizeEntry(stored, fbDef) {
  if (stored === true) return { enabled: true, auto: true };
  if (stored === false) return { enabled: fbDef.defaultEnabled, auto: false };
  if (stored && typeof stored === "object") {
    return {
      enabled: stored.enabled !== undefined ? !!stored.enabled : fbDef.defaultEnabled,
      auto: stored.auto !== undefined ? !!stored.auto : fbDef.defaultAuto,
    };
  }
  return { enabled: fbDef.defaultEnabled, auto: fbDef.defaultAuto };
}

async function loadSettings() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const raw = stored[STORAGE_KEY] || {};
    const fbStored = raw.fallbacks || {};
    const merged = {
      summaryStyle: STYLES.some((s) => s.key === raw.summaryStyle) ? raw.summaryStyle : "standard",
      fallbacks: {},
    };
    for (const f of FALLBACKS) {
      merged.fallbacks[f.key] = normalizeEntry(fbStored[f.key], f);
    }
    return merged;
  } catch (err) {
    console.warn("[NoBait popup] settings load failed, using defaults:", err);
    return defaultSettings();
  }
}

async function saveSettings(settings) {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: settings });
  } catch (err) {
    console.error("[NoBait popup] settings save failed:", err);
  }
}

// Renders the Summary style radio group at the top of the popup.
function renderStyles(settings) {
  const list = document.getElementById("style-list");
  list.innerHTML = "";

  for (const style of STYLES) {
    const checked = settings.summaryStyle === style.key;
    const li = document.createElement("li");
    li.className = "style-row" + (checked ? " is-selected" : "");

    li.innerHTML =
      `<div class="style-main">` +
        `<label class="radio-cell">` +
          `<input type="radio" name="summary-style" data-key="${style.key}" ${checked ? "checked" : ""}>` +
        `</label>` +
        `<div class="style-info">` +
          `<div class="style-label">${escapeHtml(style.label)}</div>` +
          `<div class="style-desc">${escapeHtml(style.description)}</div>` +
        `</div>` +
        `<button class="info-btn" data-key="${style.key}" type="button" title="More info">i</button>` +
      `</div>`;

    const radio = li.querySelector("input[type='radio']");
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      settings.summaryStyle = style.key;
      saveSettings(settings);
      // Update visual state on all rows
      const rows = list.querySelectorAll(".style-row");
      rows.forEach((r) => r.classList.remove("is-selected"));
      li.classList.add("is-selected");
    });

    const infoBtn = li.querySelector(".info-btn");
    infoBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openInfoModal(style.label, style.advanced);
    });

    list.appendChild(li);
  }
}

function renderFallbacks(settings) {
  const list = document.getElementById("fallback-list");
  list.innerHTML = "";

  for (const fb of FALLBACKS) {
    const entry = settings.fallbacks[fb.key] || { enabled: false, auto: false };
    const li = document.createElement("li");
    li.className = "fallback-row" + (entry.enabled ? " is-enabled" : "");

    li.innerHTML =
      `<div class="fallback-main">` +
        `<label class="checkbox-cell" title="Show this option as a button in the long-click tooltip">` +
          `<input type="checkbox" class="cb-enabled" data-key="${fb.key}" ${entry.enabled ? "checked" : ""}>` +
          `<span class="checkbox-cell-label">Show</span>` +
        `</label>` +
        `<div class="fallback-info">` +
          `<div class="fallback-label">${escapeHtml(fb.label)}</div>` +
          `<div class="fallback-desc">${escapeHtml(fb.description)}</div>` +
        `</div>` +
        `<label class="checkbox-cell auto-cell" title="Run this option automatically every long-click. Forces Show on.">` +
          `<input type="checkbox" class="cb-auto" data-key="${fb.key}" ${entry.auto ? "checked" : ""} ${entry.enabled ? "" : "disabled"}>` +
          `<span class="checkbox-cell-label">Auto</span>` +
        `</label>` +
        `<button class="info-btn" data-key="${fb.key}" type="button" title="More info">i</button>` +
      `</div>`;

    const cbEnabled = li.querySelector(".cb-enabled");
    const cbAuto = li.querySelector(".cb-auto");

    cbEnabled.addEventListener("change", () => {
      settings.fallbacks[fb.key].enabled = cbEnabled.checked;
      // Auto can't be on if Show is off — clear it and disable the checkbox.
      if (!cbEnabled.checked) {
        settings.fallbacks[fb.key].auto = false;
        cbAuto.checked = false;
        cbAuto.disabled = true;
      } else {
        cbAuto.disabled = false;
      }
      li.classList.toggle("is-enabled", cbEnabled.checked);
      saveSettings(settings);
    });

    cbAuto.addEventListener("change", () => {
      // Auto requires Enabled — turn Show on if user enables Auto.
      if (cbAuto.checked && !cbEnabled.checked) {
        cbEnabled.checked = true;
        settings.fallbacks[fb.key].enabled = true;
        cbAuto.disabled = false;
        li.classList.add("is-enabled");
      }
      settings.fallbacks[fb.key].auto = cbAuto.checked;
      saveSettings(settings);
    });

    const infoBtn = li.querySelector(".info-btn");
    infoBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openInfoModal(fb.label, fb.advanced);
    });

    list.appendChild(li);
  }
}

function openInfoModal(title, body) {
  document.getElementById("modal-title").textContent = title;
  document.getElementById("modal-body").textContent = body;
  const modal = document.getElementById("info-modal");
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
}

function closeInfoModal() {
  const modal = document.getElementById("info-modal");
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = String(str);
  return div.innerHTML;
}

(async function init() {
  try {
    const manifest = chrome.runtime.getManifest();
    document.getElementById("version-label").textContent = `v${manifest.version}`;
  } catch {}

  const settings = await loadSettings();
  renderStyles(settings);
  renderFallbacks(settings);

  document.getElementById("modal-close").addEventListener("click", closeInfoModal);
  document.getElementById("modal-backdrop").addEventListener("click", closeInfoModal);

  document.getElementById("reset-defaults").addEventListener("click", async (e) => {
    e.preventDefault();
    const def = defaultSettings();
    await saveSettings(def);
    renderStyles(def);
    renderFallbacks(def);
  });
})();
