// NoBait - Background Service Worker
// Fetches article text and calls the AI proxy for summarization

// --- Configuration ---
const PROXY_URL = "https://nobait-proxy.acr197.workers.dev/summarize";
const FETCH_TIMEOUT_MS = 10000;
const AI_TIMEOUT_MS = 15000;
const MAX_CONTENT_LENGTH = 5000;
const MIN_CONTENT_LENGTH = 50;

// --- Message listener: routes SUMMARIZE requests from the content script ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== "SUMMARIZE") return;

  handleSummarize(msg.url, msg.headline)
    .then(sendResponse)
    .catch(() =>
      sendResponse({ ok: false, error: "ai_error", message: "An unexpected error occurred." })
    );

  // Keep the message channel open for the async response
  return true;
});

// --- handleSummarize: orchestrates fetch -> extract -> AI pipeline ---
async function handleSummarize(url, headline) {
  // Phase 1: fetch and extract article text
  let articleText;
  try {
    articleText = await fetchArticle(url);
  } catch (err) {
    return { ok: false, error: err.errorType || "fetch_failed", message: err.message };
  }

  // Phase 2: send to AI proxy
  try {
    const summary = await callAI(headline, articleText);
    return { ok: true, summary };
  } catch (err) {
    return { ok: false, error: "ai_error", message: err.message || "Summarization failed." };
  }
}

// --- fetchArticle: downloads the page HTML with a timeout ---
async function fetchArticle(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; NoBait/1.0)" },
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      throw createError("fetch_failed", "Request timed out. The site took too long to respond.");
    }
    throw createError("fetch_failed", "Could not load the article. Network error.");
  }

  clearTimeout(timer);

  if (response.status === 401 || response.status === 403) {
    throw createError("paywall", "This article is behind a paywall or restricted access.");
  }
  if (response.status === 429) {
    throw createError("blocked", "This site is rate-limiting requests. Try again later.");
  }
  if (!response.ok) {
    throw createError("fetch_failed", `Could not load the article (HTTP ${response.status}).`);
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
    throw createError("fetch_failed", "The link doesn't point to a readable article.");
  }

  let html = await response.text();

  // Handle JS-based redirects (common on news aggregator redirect pages)
  const jsRedirectUrl = extractJsRedirect(html);
  if (jsRedirectUrl) {
    return fetchArticle(jsRedirectUrl);
  }

  const text = extractText(html);

  // If we got very little text and the final URL differs from the request,
  // the page may have been a redirect stub — the extracted text is fine to use
  return text;
}

// --- extractJsRedirect: detects common JS/meta redirect patterns in HTML ---
function extractJsRedirect(html) {
  // Meta refresh: <meta http-equiv="refresh" content="0;url=...">
  const metaMatch = html.match(
    /<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]+content\s*=\s*["']?\d+\s*;\s*url\s*=\s*["']?([^"'\s>]+)/i
  );
  if (metaMatch && metaMatch[1]) {
    try {
      const u = new URL(metaMatch[1]);
      if (u.protocol === "http:" || u.protocol === "https:") return u.href;
    } catch (_) { /* skip */ }
  }

  // window.location / location.href = "..."
  const jsMatch = html.match(
    /(?:window\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/i
  );
  if (jsMatch && jsMatch[1]) {
    try {
      const u = new URL(jsMatch[1]);
      if (u.protocol === "http:" || u.protocol === "https:") return u.href;
    } catch (_) { /* skip */ }
  }

  return null;
}

// --- extractText: strips HTML down to plain text ---
function extractText(html) {
  // Remove non-content blocks
  let text = html.replace(/<script[\s\S]*?<\/script>/gi, " ");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, " ");
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, " ");
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, " ");
  text = text.replace(/<header[\s\S]*?<\/header>/gi, " ");

  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, " ");

  // Decode common HTML entities
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, " ");

  // Collapse whitespace and truncate
  text = text.replace(/\s+/g, " ").trim();
  if (text.length > MAX_CONTENT_LENGTH) {
    text = text.substring(0, MAX_CONTENT_LENGTH) + "...";
  }
  if (text.length < MIN_CONTENT_LENGTH) {
    throw createError("fetch_failed", "Could not extract enough text from the article.");
  }

  return text;
}

// --- callAI: sends the prompt to the Cloudflare Worker proxy ---
async function callAI(headline, content) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  const prompt = buildPrompt(headline, content);

  let response;
  try {
    response = await fetch(PROXY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: prompt }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      throw new Error("AI request timed out.");
    }
    throw new Error("Could not reach the AI service.");
  }

  clearTimeout(timer);

  if (!response.ok) {
    throw new Error(`AI service returned an error (HTTP ${response.status}).`);
  }

  const data = await response.json();
  if (!data.summary) {
    throw new Error("AI returned an empty response.");
  }

  return data.summary;
}

// --- buildPrompt: constructs the full AI prompt from headline + content ---
function buildPrompt(headline, content) {
  return `You are NoBait, an AI that cuts through clickbait. Given a headline and the article content, provide the ACTUAL answer or key information the headline is teasing.

Rules:
- Give the direct answer in 1-3 sentences max
- No fluff, no filler, no rewording the headline
- If the headline asks a question, answer it directly
- If it's a listicle tease, give the key item(s)
- If it's rage/shock bait, state what actually happened plainly
- If the article doesn't actually answer its own headline, say so

Headline: "${headline}"

Article content:
${content}

Direct answer:`;
}

// --- createError: builds an Error with an errorType property ---
function createError(errorType, message) {
  const err = new Error(message);
  err.errorType = errorType;
  return err;
}
