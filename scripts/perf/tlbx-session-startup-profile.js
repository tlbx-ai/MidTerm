const perf = window.__codexChromePerf;
if (!perf) {
  throw new Error('Chrome perf observer was not initialized.');
}

const startedAt = performance.now();
const elapsed = () => Math.round(performance.now() - startedAt);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

perf.scenario = {
  name: 'tlbx-session-startup-profile',
  sessionId: null,
  apiResponseMs: null,
  sessionRowMs: null,
  terminalOpenedMs: null,
  foregroundProcessMs: null,
  apiBufferOutputMs: null,
  browserRenderedOutputMs: null,
  browserRenderedSequence: null,
  browserTextAtFirstOutput: null,
};

let sessionId = null;
try {
  const response = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      cols: 120,
      rows: 30,
      shell: 'Pwsh',
      workingDirectory: 'Q:\\repos\\Jpa',
      launchCommand: 'codex --yolo',
    }),
  });
  if (!response.ok) {
    throw new Error(`Session create failed: ${response.status}`);
  }

  const created = await response.json();
  sessionId = created.id;
  perf.scenario.sessionId = sessionId;
  perf.scenario.apiResponseMs = elapsed();

  const deadline = performance.now() + 12000;
  while (performance.now() < deadline) {
    const row = document.querySelector(`[data-session-id="${sessionId}"]`);
    if (row && perf.scenario.sessionRowMs === null) {
      perf.scenario.sessionRowMs = elapsed();
      row.click();
    }

    const terminalState = window.mmDebug?.terminals?.get(sessionId);
    if (terminalState?.opened && perf.scenario.terminalOpenedMs === null) {
      perf.scenario.terminalOpenedMs = elapsed();
    }

    const sessionsResponse = await fetch('/api/sessions', { cache: 'no-store' });
    if (sessionsResponse.ok) {
      const sessions = (await sessionsResponse.json()).sessions ?? [];
      const session = sessions.find((candidate) => candidate.id === sessionId);
      if (session?.foregroundName && perf.scenario.foregroundProcessMs === null) {
        perf.scenario.foregroundProcessMs = elapsed();
      }
    }

    const bufferResponse = await fetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/buffer/tail?lines=40&stripAnsi=true`,
      { cache: 'no-store' },
    );
    if (bufferResponse.ok) {
      const text = await bufferResponse.text();
      if (text.trim() && perf.scenario.apiBufferOutputMs === null) {
        perf.scenario.apiBufferOutputMs = elapsed();
      }
    }

    const renderedSequence = window.mmDebug?.transport?.get?.(sessionId)?.renderedSeq ?? null;
    const browserText = terminalState?.terminal?.buffer?.active
      ?.getLine(terminalState.terminal.buffer.active.cursorY)
      ?.translateToString(true)
      ?.trim();
    if ((renderedSequence > 0 || browserText) && perf.scenario.browserRenderedOutputMs === null) {
      perf.scenario.browserRenderedOutputMs = elapsed();
      perf.scenario.browserRenderedSequence = String(renderedSequence);
      perf.scenario.browserTextAtFirstOutput = browserText || null;
    }

    if (
      perf.scenario.apiBufferOutputMs !== null &&
      perf.scenario.browserRenderedOutputMs !== null
    ) {
      break;
    }
    await sleep(50);
  }
} finally {
  if (sessionId) {
    await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
  }
}

perf.scenario;
