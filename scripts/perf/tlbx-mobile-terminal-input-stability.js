const perf = window.__codexChromePerf;
if (!perf) {
  throw new Error("Chrome perf observer was not initialized.");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, label, timeoutMs = 15000) {
  const deadline = performance.now() + timeoutMs;
  do {
    const value = predicate();
    if (value) return value;
    await sleep(100);
  } while (performance.now() < deadline);
  throw new Error(`Timed out waiting for ${label}`);
}

await waitFor(() => document.readyState === "complete", "document ready");

let createdSessionId = null;
if (document.querySelectorAll(".terminal-container").length === 0) {
  const response = await fetch("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cols: 96, rows: 28, shell: "Pwsh" }),
  });
  if (!response.ok) {
    throw new Error(`Session create failed: ${response.status}`);
  }
  const createdSession = await response.json();
  createdSessionId = createdSession.id;
}

const terminalContainer = await waitFor(
  () => document.querySelector(".terminal-container:not(.hidden)"),
  "visible terminal",
);
const terminalTextarea = await waitFor(
  () => terminalContainer.querySelector("textarea.xterm-helper-textarea"),
  "xterm input textarea",
);
await sleep(1500);

const terminalPage = document.querySelector(".terminal-page");
const initialContainerRect = terminalContainer.getBoundingClientRect();
const initialPageRect = terminalPage?.getBoundingClientRect() ?? null;
const initialViewportHeight = getComputedStyle(document.documentElement)
  .getPropertyValue("--midterm-visual-viewport-height")
  .trim();
let terminalResizeCommands = 0;
let containerResizeCallbacks = 0;
let pageResizeCallbacks = 0;

const originalWebSocketSend = WebSocket.prototype.send;
WebSocket.prototype.send = function captureTerminalResize(data) {
  if (typeof data === "string" && data.includes('"terminal.resize"')) {
    terminalResizeCommands += 1;
  }
  return originalWebSocketSend.call(this, data);
};

const containerObserver = new ResizeObserver(() => {
  containerResizeCallbacks += 1;
});
containerObserver.observe(terminalContainer);
const pageObserver = terminalPage
  ? new ResizeObserver(() => {
      pageResizeCallbacks += 1;
    })
  : null;
pageObserver?.observe(terminalPage);

try {
  terminalTextarea.focus({ preventScroll: true });
  for (const character of "mobile-input-stability") {
    terminalTextarea.value = character;
    terminalTextarea.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        data: character,
        inputType: "insertText",
      }),
    );
    await sleep(25);
  }
  await sleep(500);
} finally {
  WebSocket.prototype.send = originalWebSocketSend;
  containerObserver.disconnect();
  pageObserver?.disconnect();
}

const finalContainerRect = terminalContainer.getBoundingClientRect();
const finalPageRect = terminalPage?.getBoundingClientRect() ?? null;
const finalViewportHeight = getComputedStyle(document.documentElement)
  .getPropertyValue("--midterm-visual-viewport-height")
  .trim();

perf.scenario = {
  name: "tlbx-mobile-terminal-input-stability",
  characters: "mobile-input-stability".length,
  terminalResizeCommands,
  containerResizeCallbacks,
  pageResizeCallbacks,
  containerRectChanged:
    initialContainerRect.width !== finalContainerRect.width ||
    initialContainerRect.height !== finalContainerRect.height,
  pageRectChanged:
    initialPageRect && finalPageRect
      ? initialPageRect.width !== finalPageRect.width || initialPageRect.height !== finalPageRect.height
      : null,
  visualViewportHeightChanged: initialViewportHeight !== finalViewportHeight,
};

if (
  perf.scenario.terminalResizeCommands !== 0 ||
  perf.scenario.containerRectChanged ||
  perf.scenario.pageRectChanged ||
  perf.scenario.visualViewportHeightChanged
) {
  throw new Error(`Mobile terminal input changed layout: ${JSON.stringify(perf.scenario)}`);
}

if (createdSessionId) {
  await fetch(`/api/sessions/${encodeURIComponent(createdSessionId)}`, { method: "DELETE" });
}
