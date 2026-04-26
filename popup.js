// popup.js — Settings UI for NoBait v2.
// Renders the fallback-strategy toggles, persists changes to chrome.storage.local
// under the key `nobaitSettings`, and shows an advanced-info modal on demand.

// Source of truth for fallback strategies. The `key` matches the field
// background.js reads from settings.fallbacks. `defaultEnabled` is the
// first-run default (favoring fast + reliable + free). `description` is
// shown inline (1 sentence + tradeoff). `advanced` shows in the info modal.
const FALLBACKS = [
  {
    key: "jsonLd",
    label: "Embedded body",
    description:
      "Many articles ship their full text in invisible page metadata for SEO crawlers — this reads it directly. Free, instant.",
    advanced:
      "Looks for <script type='application/ld+json'> blocks containing NewsArticle / Article schema with an articleBody field. Common on NYT, WaPo, BBC, Reuters, AP, and most modern CMS-published sites. Often returns the entire article body even on paywalled pages because the metadata is shipped to crawlers regardless of the user's subscription state.",
    defaultEnabled: true,
  },
  {
    key: "metaDesc",
    label: "Page summary",
    description:
      "Falls back to the article's social-media preview text (2-3 sentences). Free; less detail than a full summary.",
    advanced:
      "Reads <meta name='description'>, <meta property='og:description'>, and <meta name='twitter:description'>. These are 2-3 sentence summaries the publisher writes for Google / Facebook / Twitter previews. Usually present even on paywalled articles. Quality varies — some publishers write substantive descriptions, others just paste the headline.",
    defaultEnabled: true,
  },
  {
    key: "cookies",
    label: "Use my cookies",
    description:
      "Sends your existing browser session, so subscriber sites you're already logged into return the full article. Free.",
    advanced:
      "Adds credentials: 'include' to the fetch request. If you're logged into NYT, FT, Bloomberg, etc. in this browser, the publisher sees your session cookie and serves subscriber-tier HTML — the same content you'd see by clicking the link normally. Has no effect on sites you aren't logged into. Some publishers' anti-bot still blocks based on missing browser fingerprint, so this isn't a guaranteed bypass.",
    defaultEnabled: true,
  },
  {
    key: "amp",
    label: "AMP version",
    description:
      "Tries the article's mobile/AMP URL — often free of paywalls and ads. Adds a few seconds; doesn't always exist.",
    advanced:
      "Many publishers serve a stripped-down 'AMP' (Accelerated Mobile Pages) version at /amp/ or ?amp=1. AMP pages usually have the full article body and no paywall because they're served to Google's mobile snippets. Hit rate ~30–50% depending on publisher. Tried via URL pattern transforms (/amp/<slug>, /<slug>/amp, ?amp=1).",
    defaultEnabled: false,
  },
  {
    key: "twelveFt",
    label: "12ft.io proxy",
    description:
      "Routes the fetch through a public bypass service that pretends to be Googlebot. Slow; sometimes blocked; third-party.",
    advanced:
      "Sends the URL to https://12ft.io/<url> which fetches the article masquerading as Googlebot. Works on publishers that whitelist Googlebot for SEO. Quality is inconsistent because 12ft.io itself gets blocked by anti-bot from time to time. Privacy note: enabling this means the URL of every blocked article you long-press is sent to 12ft.io.",
    defaultEnabled: false,
  },
  {
    key: "altSource",
    label: "Alternative source",
    description:
      "Searches for similar coverage from other publishers and summarizes one of those instead. Slow (5-15 sec); reliable when working.",
    advanced:
      "Hits Google News RSS search with the headline, walks up to 5 candidates from different publishers, skips any that are paywalled or blocked, and summarizes the first clean one. Always cites which publisher it ended up using. Fails when the story is exclusive to the original publisher or when the headline is too generic.",
    defaultEnabled: false,
  },
  {
    key: "archive",
    label: "Wayback archive",
    description:
      "Looks up an archive.org snapshot and summarizes that. Slow; many recent articles aren't archived yet.",
    advanced:
      "Queries archive.org's Wayback availability API for the closest snapshot, then fetches the raw saved page (id_ modifier strips the Wayback toolbar wrapper) and summarizes it. Reliable for older articles, often misses recent ones (Wayback's index lags by hours/days). Not a true paywall bypass — only works for content Wayback captured publicly.",
    defaultEnabled: false,
  },
];

const STORAGE_KEY = "nobaitSettings";

// Default settings derived from the FALLBACKS metadata.
function defaultSettings() {
  const fallbacks = {};
  for (const f of FALLBACKS) fallbacks[f.key] = f.defaultEnabled;
  return { fallbacks };
}

// Reads settings from chrome.storage.local, fills missing keys with defaults.
async function loadSettings() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const def = defaultSettings();
    const fb = (stored[STORAGE_KEY] && stored[STORAGE_KEY].fallbacks) || {};
    return { fallbacks: { ...def.fallbacks, ...fb } };
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

// Renders the fallback list, wiring change + info-button events.
function renderFallbacks(settings) {
  const list = document.getElementById("fallback-list");
  list.innerHTML = "";

  for (const fb of FALLBACKS) {
    const checked = !!settings.fallbacks[fb.key];
    const li = document.createElement("li");
    li.className = "fallback-row";
    li.innerHTML =
      `<label>` +
        `<input type="checkbox" data-key="${fb.key}" ${checked ? "checked" : ""}>` +
        `<div class="fallback-info">` +
          `<div class="fallback-label">${escapeHtml(fb.label)}</div>` +
          `<div class="fallback-desc">${escapeHtml(fb.description)}</div>` +
        `</div>` +
        `<button class="info-btn" data-key="${fb.key}" type="button" title="More info">i</button>` +
      `</label>`;

    const cb = li.querySelector("input[type='checkbox']");
    cb.addEventListener("change", () => {
      settings.fallbacks[fb.key] = cb.checked;
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

// Boot
(async function init() {
  // Version label from manifest
  try {
    const manifest = chrome.runtime.getManifest();
    document.getElementById("version-label").textContent = `v${manifest.version}`;
  } catch {}

  const settings = await loadSettings();
  renderFallbacks(settings);

  document.getElementById("modal-close").addEventListener("click", closeInfoModal);
  document.getElementById("modal-backdrop").addEventListener("click", closeInfoModal);

  document.getElementById("reset-defaults").addEventListener("click", async (e) => {
    e.preventDefault();
    const def = defaultSettings();
    await saveSettings(def);
    renderFallbacks(def);
  });
})();
