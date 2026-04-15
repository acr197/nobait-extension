// NoBait Proxy Worker
//
// Deployed to: https://nobait-proxy.acr197.workers.dev
//
// This Worker is the ONLY place the OpenAI API key lives. The browser
// extension (background.js) posts headlines and article text here and reads
// a summary back, so the extension itself never ships or needs an API key.
//
// Contract:
//   POST /summarize
//     Request body:  { "text": "<headline or full prompt>" }
//     Response body: { "summary": "<model output>", "model": "gpt-5", "version": "<WORKER_VERSION>" }
//     Error bodies:  { "error": "<code>", "detail"?: "<string>" }
//
//   GET  /                or /health
//     Health probe: { "ok": true, "version": "<WORKER_VERSION>", "model": "gpt-5" }
//
// Secrets (set via `wrangler secret put` or the Cloudflare dashboard —
// NEVER committed):
//   OPENAI_API_KEY   — required. Key used for api.openai.com/v1/responses.
//
// Model: defaults to gpt-5 via the OpenAI Responses API
// (POST https://api.openai.com/v1/responses).

const WORKER_VERSION = "1.0.1";
const DEFAULT_MODEL = "gpt-5";
const OPENAI_URL = "https://api.openai.com/v1/responses";
// Conservative upstream timeout so a slow model response doesn't hold the
// extension's AI_TIMEOUT_MS (20 s) hostage. 45 s gives gpt-5 room for
// web-search reasoning while still failing well before the extension gives up.
const UPSTREAM_TIMEOUT_MS = 45000;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(body, status, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign(
      { "Content-Type": "application/json" },
      CORS_HEADERS,
      extraHeaders || {},
    ),
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // Health probe — useful for smoke tests from the extension DevTools
    // and from `curl https://nobait-proxy.acr197.workers.dev/health`.
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return json({
        ok: true,
        service: "nobait-proxy",
        version: WORKER_VERSION,
        model: DEFAULT_MODEL,
        hasKey: !!env.OPENAI_API_KEY,
      });
    }

    if (url.pathname !== "/summarize") {
      return json({ error: "not_found" }, 404);
    }
    if (request.method !== "POST") {
      return json({ error: "method_not_allowed" }, 405);
    }

    if (!env.OPENAI_API_KEY) {
      return json(
        { error: "server_misconfigured", detail: "OPENAI_API_KEY secret is not set" },
        500,
      );
    }

    let payload;
    try {
      payload = await request.json();
    } catch (_) {
      return json({ error: "invalid_json" }, 400);
    }

    const text = payload && typeof payload.text === "string" ? payload.text.trim() : "";
    if (!text) return json({ error: "missing_text" }, 400);

    // Bound the upstream call so a stalled OpenAI response can't pin the
    // Worker indefinitely.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

    let openaiResp;
    try {
      openaiResp = await fetch(OPENAI_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: DEFAULT_MODEL,
          input: text,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const aborted = err && err.name === "AbortError";
      return json(
        {
          error: aborted ? "upstream_timeout" : "upstream_network",
          detail: (err && err.message) || String(err),
        },
        502,
      );
    }
    clearTimeout(timer);

    if (!openaiResp.ok) {
      // Surface the OpenAI status + body prefix so the extension debug log
      // can distinguish auth errors (401), rate limits (429), model
      // unavailability (404/400), etc.
      const detail = await openaiResp.text().catch(() => "");
      return json(
        {
          error: "upstream_error",
          status: openaiResp.status,
          detail: detail.slice(0, 500),
        },
        502,
      );
    }

    let data;
    try {
      data = await openaiResp.json();
    } catch (_) {
      return json({ error: "upstream_invalid_json" }, 502);
    }

    const summary = extractSummary(data);
    if (!summary) {
      // The request succeeded but the response was empty — surface that so
      // the extension can fall through to the next pipeline stage instead
      // of silently serving an empty string.
      return json(
        {
          error: "empty_response",
          detail: "Model returned no output text",
          model: DEFAULT_MODEL,
          version: WORKER_VERSION,
        },
        502,
      );
    }

    return json({
      summary,
      model: DEFAULT_MODEL,
      version: WORKER_VERSION,
    });
  },
};

// Walk the OpenAI Responses API payload and return the concatenated text.
// Supports both the convenience `output_text` field and the canonical
// `output[].content[].text` structure.
function extractSummary(data) {
  if (!data) return "";
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }
  const output = Array.isArray(data.output) ? data.output : [];
  const chunks = [];
  for (const item of output) {
    if (!item || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (!part) continue;
      if (typeof part.text === "string") chunks.push(part.text);
      else if (part.text && typeof part.text.value === "string") chunks.push(part.text.value);
    }
  }
  return chunks.join("\n").trim();
}
