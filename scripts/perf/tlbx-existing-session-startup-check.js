const perf = window.__codexChromePerf;
if (!perf) {
  throw new Error("Chrome perf observer was not initialized.");
}

const startedAt = performance.now();
const elapsed = () => Math.round(performance.now() - startedAt);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

perf.scenario = {
  name: "tlbx-existing-session-startup-check",
  selectedSessionId: null,
  selectionMs: null,
  activeSessionMs: null,
  terminalOpenedMs: null,
  terminalVisibleMs: null,
  terminalBufferMs: null,
  terminalDomTextMs: null,
  activeSessionId: null,
  final: null,
};

const sessionsResponse = await fetch("/api/sessions", { cache: "no-store" });
if (!sessionsResponse.ok) {
  throw new Error(`Session list failed: ${sessionsResponse.status}`);
}
const sessions = (await sessionsResponse.json()).sessions ?? [];
const selectedSession =
  sessions.find(
    (session) => session.bookmarkId && !session.appServerControlOnly,
  ) ?? sessions.find((session) => !session.appServerControlOnly);
if (!selectedSession?.id) {
  throw new Error("No terminal session is available.");
}
perf.scenario.selectedSessionId = selectedSession.id;

const deadline = performance.now() + 5000;
while (performance.now() < deadline) {
  const snapshot = window.mmDebug?.perf?.snapshot?.();
  const terminalSummary = snapshot?.terminalSummary;
  const activeId = terminalSummary?.activeId ?? null;
  const activeTerminal =
    terminalSummary?.terminals?.find((terminal) => terminal.active) ?? null;
  const xtermText = document
    .querySelector(".session-wrapper:not(.hidden) .xterm-rows")
    ?.textContent?.trim();

  if (activeId === selectedSession.id && perf.scenario.selectionMs === null) {
    perf.scenario.selectionMs = elapsed();
  }
  if (activeId && perf.scenario.activeSessionMs === null) {
    perf.scenario.activeSessionMs = elapsed();
    perf.scenario.activeSessionId = activeId;
  }
  if (activeTerminal?.opened && perf.scenario.terminalOpenedMs === null) {
    perf.scenario.terminalOpenedMs = elapsed();
  }
  if (activeTerminal?.visible && perf.scenario.terminalVisibleMs === null) {
    perf.scenario.terminalVisibleMs = elapsed();
  }
  if (
    (activeTerminal?.bufferLength ?? 0) > 1 &&
    perf.scenario.terminalBufferMs === null
  ) {
    perf.scenario.terminalBufferMs = elapsed();
  }
  if (xtermText && perf.scenario.terminalDomTextMs === null) {
    perf.scenario.terminalDomTextMs = elapsed();
  }

  if (
    perf.scenario.activeSessionMs !== null &&
    perf.scenario.terminalOpenedMs !== null &&
    perf.scenario.terminalVisibleMs !== null &&
    perf.scenario.terminalBufferMs !== null
  ) {
    break;
  }

  await sleep(25);
}

perf.scenario.final =
  window.mmDebug?.perf?.snapshot?.()?.terminalSummary ?? null;
perf.scenario;
