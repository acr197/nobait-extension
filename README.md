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

> **Firefox new tab:** Firefox runs `about:newtab` / `about:home` in a privileged content process and blocks every WebExtension content script from injecting into it. To make NoBait work there, NoBait ships a drop-in replacement new tab page that mirrors Firefox's Discovery Stream layout (headline cards + search) and pulls live stories from Mozilla's public Merino endpoint — the same service that powers Firefox's own feed — with a curated fallback when the network is unavailable. Firefox will prompt you to approve the new tab override the first time you open a tab after install. Long-click continues to work everywhere else: search results, news sites, Google News, social media link previews, etc.

## Tech

Cross-browser WebExtension (Manifest V3) — Chrome & Firefox — + AI API
