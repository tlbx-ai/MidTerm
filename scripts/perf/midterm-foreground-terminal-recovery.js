const perf = window.__codexChromePerf;
if (!perf) {
  throw new Error("Chrome perf observer was not initialized.");
}

perf.scenario = {
  name: "midterm-foreground-terminal-recovery",
  sessionId: null,
  terminalCountBefore: 0,
  refreshCallsBeforeFreeze: 0,
  refreshCallsAfterResume: 0,
  refreshCallsAfterFocusPulse: 0,
  claimedReferenceBrowser: false,
  isMainBrowserBeforeFreeze: null,
  xtermsAfterOpen: 0,
  hiddenAtMs: null,
  visibleAtMs: null,
  reconnectedAtMs: null,
  inputReadyAtMs: null,
  resumeConnectedMs: null,
  resumeInputReadyMs: null,
  connectionTransitions: [],
  terminalElementPreserved: null,
  terminalContainerPreserved: null,
  xtermsAfterResume: null,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, label, timeoutMs = 10000) {
  const deadline = performance.now() + timeoutMs;
  do {
    const value = predicate();
    if (value) return value;
    await sleep(100);
  } while (performance.now() < deadline);
  throw new Error(`Timed out waiting for ${label}`);
}

const created = await fetch("/api/sessions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ cols: 96, rows: 28, shell: "Pwsh" }),
}).then((response) => {
  if (!response.ok) {
    throw new Error(`Session create failed: ${response.status}`);
  }
  return response.json();
});

perf.scenario.sessionId = created.id;

await waitFor(
  () => document.querySelector(`[data-session-id="${created.id}"]`),
  "created session row",
);
document.querySelector(`[data-session-id="${created.id}"]`)?.click();
await waitFor(
  () => window.mmDebug?.activeId === created.id,
  "created session selected",
);

const state = await waitFor(() => {
  const terminalState = window.mmDebug?.terminals?.get(created.id);
  return terminalState?.opened ? terminalState : null;
}, "opened terminal");

perf.scenario.terminalCountBefore = window.mmDebug?.terminals?.size ?? 0;
perf.scenario.xtermsAfterOpen = document.querySelectorAll(".xterm").length;

const claimOverlay = document.querySelector(
  ".terminal-container.scaled .scaled-overlay",
);
if (claimOverlay) {
  claimOverlay.click();
  perf.scenario.claimedReferenceBrowser = true;
  await waitFor(
    () =>
      !document.body.innerText.includes(
        "Make this the reference scale browser",
      ),
    "reference browser claim",
  );
  await sleep(500);
}

const originalRefresh = state.terminal.refresh.bind(state.terminal);
state.terminal.refresh = (...args) => {
  perf.scenario.refreshCallsAfterResume += 1;
  return originalRefresh(...args);
};

const terminalElementBeforeFreeze = state.container.querySelector(".xterm");
const inputBeforeFreeze = state.container.querySelector(
  "textarea.xterm-helper-textarea",
);
let sawReconnectTransition = false;

function recordConnectionState() {
  const badge = document.getElementById("connection-status");
  const status = badge?.className ?? "missing";
  perf.scenario.connectionTransitions.push({
    atMs: performance.now(),
    status,
  });

  if (!perf.scenario.visibleAtMs) return;
  if (!badge?.classList.contains("connected")) {
    sawReconnectTransition = true;
    return;
  }
  if (!sawReconnectTransition || perf.scenario.reconnectedAtMs) return;

  perf.scenario.reconnectedAtMs = performance.now();
  perf.scenario.resumeConnectedMs =
    perf.scenario.reconnectedAtMs - perf.scenario.visibleAtMs;

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const currentState = window.mmDebug?.terminals?.get(created.id);
      const inputAfterResume = currentState?.container?.querySelector(
        "textarea.xterm-helper-textarea",
      );
      perf.scenario.inputReadyAtMs = performance.now();
      perf.scenario.resumeInputReadyMs =
        perf.scenario.inputReadyAtMs - perf.scenario.visibleAtMs;
      perf.scenario.terminalElementPreserved =
        currentState?.container?.querySelector(".xterm") ===
        terminalElementBeforeFreeze;
      perf.scenario.terminalContainerPreserved =
        currentState?.container === state.container;
      perf.scenario.inputElementPreserved =
        inputAfterResume === inputBeforeFreeze;
      perf.scenario.xtermsAfterResume =
        document.querySelectorAll(".xterm").length;
    });
  });
}

const connectionBadge = document.getElementById("connection-status");
if (connectionBadge) {
  new MutationObserver(recordConnectionState).observe(connectionBadge, {
    attributes: true,
    attributeFilter: ["class"],
  });
  recordConnectionState();
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    perf.scenario.hiddenAtMs = performance.now();
    return;
  }
  perf.scenario.visibleAtMs = performance.now();
});

perf.scenario.refreshCallsBeforeFreeze = perf.scenario.refreshCallsAfterResume;
perf.scenario.isMainBrowserBeforeFreeze =
  document.body.innerText.includes("Make this the reference scale browser") ===
  false;

window.dispatchEvent(new Event("focus"));
await sleep(300);
perf.scenario.refreshCallsAfterFocusPulse =
  perf.scenario.refreshCallsAfterResume;
