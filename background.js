// background.js — Service worker for NoBait v2
// Resolves redirect chains via native fetch (HEAD, redirect: follow)

const FETCH_TIMEOUT_MS = 5000;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "resolve-url") return false;

  const originalUrl = message.url;
  const requestId = message.requestId || "unknown";

  console.log(
    `[NoBait BG] requestId=${requestId} | Received resolve request for: ${originalUrl}`
  );

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
    console.warn(
      `[NoBait BG] requestId=${requestId} | Fetch aborted after ${FETCH_TIMEOUT_MS}ms timeout for: ${originalUrl}`
    );
  }, FETCH_TIMEOUT_MS);

  fetch(originalUrl, {
    method: "HEAD",
    redirect: "follow",
    signal: controller.signal,
  })
    .then((response) => {
      clearTimeout(timeoutId);
      const resolvedUrl = response.url;
      console.log(
        `[NoBait BG] requestId=${requestId} | Resolved successfully\n` +
          `  original : ${originalUrl}\n` +
          `  resolved : ${resolvedUrl}\n` +
          `  status   : ${response.status}\n` +
          `  redirected: ${response.redirected}`
      );
      sendResponse({
        success: true,
        resolvedUrl,
        originalUrl,
        status: response.status,
        redirected: response.redirected,
        requestId,
      });
    })
    .catch((error) => {
      clearTimeout(timeoutId);
      const reason =
        error.name === "AbortError"
          ? `Fetch timed out after ${FETCH_TIMEOUT_MS}ms`
          : error.message;
      console.error(
        `[NoBait BG] requestId=${requestId} | Fetch FAILED for: ${originalUrl}\n` +
          `  error.name   : ${error.name}\n` +
          `  error.message: ${error.message}\n` +
          `  reason       : ${reason}\n` +
          `  stack        : ${error.stack || "N/A"}`
      );
      sendResponse({
        success: false,
        error: reason,
        errorName: error.name,
        errorStack: error.stack || "N/A",
        originalUrl,
        requestId,
      });
    });

  // Return true to indicate we will call sendResponse asynchronously
  return true;
});

console.log("[NoBait BG] Service worker loaded and listening for resolve-url messages.");
