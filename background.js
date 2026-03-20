// NoBait - Background Service Worker
// Handles article fetching and AI summarization

const DEFAULT_PROXY_URL = "https://nobait-proxy.example.com/summarize";
const FETCH_TIMEOUT_MS = 10000;
const AI_TIMEOUT_MS = 15000;
const MAX_CONTENT_LENGTH = 5000;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "SUMMARIZE") {
    handleSummarize(msg.url, msg.headline)
      .then(sendResponse)
      .catch(() => sendResponse({
        ok: false,
        error: "ai_error",
        message: "An unexpected error occurred."
      }));
    return true; // keep message channel open for async response
  }
});

async function handleSummarize(url, headline) {
  // Phase 1: Fetch article content
  let articleText;
  try {
    articleText = await fetchArticle(url);
  } catch (err) {
    return {
      ok: false,
      error: err.errorType || "fetch_failed",
      message: err.message
    };
  }

  // Phase 2: AI summarization
  try {
    const summary = await callAI(headline, articleText);
    return { ok: true, summary };
  } catch (err) {
    return {
      ok: false,
      error: "ai_error",
      message: err.message || "Summarization failed."
    };
  }
}

async function fetchArticle(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; NoBait/1.0)"
      }
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
    throw createError("blocked", "This site is rate-limiting requests.");
  }
  if (!response.ok) {
    throw createError("fetch_failed", `Could not load the article (HTTP ${response.status}).`);
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
    throw createError("fetch_failed", "The link doesn't point to a readable article.");
  }

  const html = await response.text();
  return extractText(html);
}

function extractText(html) {
  // Strip script and style blocks
  let text = html.replace(/<script[\s\S]*?<\/script>/gi, " ");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, " ");
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, " ");
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, " ");
  text = text.replace(/<header[\s\S]*?<\/header>/gi, " ");

  // Strip all HTML tags
  text = text.replace(/<[^>]+>/g, " ");

  // Decode common HTML entities
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, " ");

  // Collapse whitespace
  text = text.replace(/\s+/g, " ").trim();

  // Truncate
  if (text.length > MAX_CONTENT_LENGTH) {
    text = text.substring(0, MAX_CONTENT_LENGTH) + "...";
  }

  if (text.length < 50) {
    throw createError("fetch_failed", "Could not extract enough text from the article.");
  }

  return text;
}

async function callAI(headline, content) {
  const proxyUrl = await getProxyUrl();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  const prompt = buildPrompt(headline, content);

  let response;
  try {
    response = await fetch(proxyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ headline, content, prompt }),
      signal: controller.signal
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

async function getProxyUrl() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(["proxyUrl"], (result) => {
      resolve(result.proxyUrl || DEFAULT_PROXY_URL);
    });
  });
}

function createError(errorType, message) {
  const err = new Error(message);
  err.errorType = errorType;
  return err;
}
