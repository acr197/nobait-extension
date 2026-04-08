# NoBait

**See through clickbait instantly.**

## AI-powered summaries

NoBait uses AI to extract the real answer behind headlines in seconds.
It pulls context from the source (or closest match) and returns a short, direct answer.

## How it works

- Long-click any article link
- Instant popup appears
- Get the actual answer, not the bait

## Features

- Fast hover summaries
- Handles paywalls + blocked sources with fallback
- Clean, minimal UI
- Privacy-first (no tracking)

## Setup

### Chrome

1. Clone this repo
2. Open `chrome://extensions` > Enable Developer Mode
3. Click "Load unpacked" > Select this folder
4. Click the NoBait icon to set your AI proxy URL

### Firefox

1. Clone this repo
2. Open `about:debugging` > This Firefox > Load Temporary Add-on
3. Select `manifest.json` from this folder

> **Known Firefox limitation:** NoBait cannot run on Firefox's default new tab page (`about:newtab` / `about:home`, including the "Popular Today" Pocket feed). Firefox loads these in a privileged content process and blocks all WebExtension content scripts from injecting into them. The only way to interact with that page is to override it entirely, which would replace Mozilla's curated feed and Top Sites — NoBait deliberately does not do that. Long-click works everywhere else: search results, news sites, Google News, social media link previews, etc.

## Tech

Cross-browser WebExtension (Manifest V3) — Chrome & Firefox — + AI API
