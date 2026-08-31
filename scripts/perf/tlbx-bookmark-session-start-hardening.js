const perf = window.__codexChromePerf;
if (!perf) {
  throw new Error('Chrome perf observer was not initialized.');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const startedAt = performance.now();
const elapsed = () => Math.round(performance.now() - startedAt);

async function waitFor(probe, label, timeoutMs = 20000) {
  const deadline = performance.now() + timeoutMs;
  do {
    const value = await probe();
    if (value) return value;
    await sleep(50);
  } while (performance.now() < deadline);
  throw new Error(`Timed out waiting for ${label}`);
}

async function readSessions() {
  const response = await fetch('/api/sessions', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Session list failed: ${response.status}`);
  const body = await response.json();
  return body.sessions ?? body;
}

function readTerminalText(terminalState) {
  const buffer = terminalState?.terminal?.buffer?.active;
  if (!buffer) return '';
  const lines = [];
  for (let index = 0; index < buffer.length; index += 1) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? '');
  }
  return lines.join('\n');
}

perf.scenario = {
  name: 'tlbx-bookmark-session-start-hardening',
  bookmarkId: null,
  pendingObservedMs: null,
  sessionId: null,
  sessionCreatedMs: null,
  terminalOpenedMs: null,
  codexReadyMs: null,
  typedProbeRenderedMs: null,
  duplicateSessionCount: null,
  abortedLaunchReconciled: false,
  idempotentConcurrentLaunch: false,
  stressSessionCount: 0,
  cleanupComplete: false,
};

const sessionsToDelete = new Set();
let bookmarkId = null;
let pendingObserver = null;
try {
  await waitFor(() => document.readyState === 'complete', 'document ready');
  const baselineIds = new Set((await readSessions()).map((session) => session.id));
  const marker = `Codex startup proof ${crypto.randomUUID().slice(0, 8)}`;
  const historyResponse = await fetch('/api/history', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      shellType: 'Pwsh',
      executable: 'codex',
      commandLine: 'codex --yolo',
      workingDirectory: 'Q:\\repos\\tlbx-1',
      dedupeKey: `perf-${crypto.randomUUID()}`,
      isStarred: true,
      label: marker,
      launchMode: 'terminal',
      launchOrigin: 'adHoc',
      surfaceType: 'terminal',
    }),
  });
  if (!historyResponse.ok) throw new Error(`Bookmark create failed: ${historyResponse.status}`);
  bookmarkId = (await historyResponse.json()).id;
  perf.scenario.bookmarkId = bookmarkId;

  pendingObserver = new MutationObserver(() => {
    if (
      perf.scenario.pendingObservedMs === null &&
      document.querySelector('[data-session-id^="pending-"]')
    ) {
      perf.scenario.pendingObservedMs = elapsed();
    }
  });
  pendingObserver.observe(document.documentElement, { childList: true, subtree: true });

  document.getElementById('btn-bookmarks')?.click();
  const bookmarkItem = await waitFor(
    () => document.querySelector(`.history-item[data-id="${bookmarkId}"]`),
    'temporary bookmark row',
  );
  bookmarkItem.click();
  bookmarkItem.click();

  const created = await waitFor(async () => {
    const sessions = await readSessions();
    return sessions.find((session) => !baselineIds.has(session.id)) ?? null;
  }, 'bookmark-created session');
  sessionsToDelete.add(created.id);
  perf.scenario.sessionId = created.id;
  perf.scenario.sessionCreatedMs = elapsed();

  const terminalState = await waitFor(() => {
    const state = window.mmDebug?.terminals?.get(created.id);
    return state?.opened ? state : null;
  }, 'opened xterm');
  perf.scenario.terminalOpenedMs = elapsed();

  await waitFor(() => {
    const text = readTerminalText(terminalState);
    return /OpenAI Codex|codex|for shortcuts|What can I help/i.test(text) ? text : null;
  }, 'rendered Codex interface', 30000);
  perf.scenario.codexReadyMs = elapsed();

  terminalState.terminal.paste('z');
  await waitFor(() => readTerminalText(terminalState).includes('z'), 'typed Codex composer probe');
  perf.scenario.typedProbeRenderedMs = elapsed();

  await sleep(750);
  const bookmarkSessions = (await readSessions()).filter(
    (session) => !baselineIds.has(session.id),
  );
  perf.scenario.duplicateSessionCount = bookmarkSessions.length;
  if (bookmarkSessions.length !== 1) {
    throw new Error(`Double bookmark click created ${bookmarkSessions.length} sessions.`);
  }
  if (perf.scenario.pendingObservedMs === null) {
    throw new Error('The optimistic pending session never became visible in the DOM.');
  }

  const reconcileId = `abort-${crypto.randomUUID()}`;
  const reconcileBody = {
    cols: 96,
    rows: 28,
    shell: 'Pwsh',
    workingDirectory: 'Q:\\repos\\tlbx-1',
    launchRequestId: reconcileId,
  };
  const abortController = new AbortController();
  const abandonedRequest = fetch('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(reconcileBody),
    signal: abortController.signal,
  }).catch(() => null);
  abortController.abort();
  await abandonedRequest;
  const reconciledResponse = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(reconcileBody),
  });
  if (!reconciledResponse.ok) {
    throw new Error(`Aborted launch reconciliation failed: ${reconciledResponse.status}`);
  }
  const reconciled = await reconciledResponse.json();
  sessionsToDelete.add(reconciled.id);
  perf.scenario.abortedLaunchReconciled = true;

  const concurrentId = `concurrent-${crypto.randomUUID()}`;
  const concurrentBody = JSON.stringify({
    cols: 96,
    rows: 28,
    shell: 'Pwsh',
    workingDirectory: 'Q:\\repos\\tlbx-1',
    launchRequestId: concurrentId,
  });
  const createConcurrent = () =>
    fetch('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: concurrentBody,
    });
  const concurrentResponses = await Promise.all([createConcurrent(), createConcurrent()]);
  if (concurrentResponses.some((response) => !response.ok)) {
    throw new Error('Concurrent idempotent launch returned a failed response.');
  }
  const concurrentSessions = await Promise.all(
    concurrentResponses.map((response) => response.json()),
  );
  if (concurrentSessions[0].id !== concurrentSessions[1].id) {
    throw new Error('Concurrent idempotent launch created two different sessions.');
  }
  sessionsToDelete.add(concurrentSessions[0].id);
  perf.scenario.idempotentConcurrentLaunch = true;

  const stressResponses = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      fetch('/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          cols: 80,
          rows: 24,
          shell: 'Pwsh',
          workingDirectory: 'Q:\\repos\\tlbx-1',
          launchRequestId: `stress-${index}-${crypto.randomUUID()}`,
        }),
      }),
    ),
  );
  if (stressResponses.some((response) => !response.ok)) {
    throw new Error('Concurrent session-start stress returned a failed response.');
  }
  const stressSessions = await Promise.all(stressResponses.map((response) => response.json()));
  for (const session of stressSessions) {
    sessionsToDelete.add(session.id);
  }
  perf.scenario.stressSessionCount = new Set(stressSessions.map((session) => session.id)).size;
  if (perf.scenario.stressSessionCount !== 12) {
    throw new Error(`Session-start stress created only ${perf.scenario.stressSessionCount} sessions.`);
  }
} finally {
  pendingObserver?.disconnect();
  for (const sessionId of sessionsToDelete) {
    await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
  }
  if (bookmarkId) {
    await fetch(`/api/history/${encodeURIComponent(bookmarkId)}`, { method: 'DELETE' });
  }
  await waitFor(async () => {
    const liveIds = new Set((await readSessions()).map((session) => session.id));
    const apiClean = [...sessionsToDelete].every((sessionId) => !liveIds.has(sessionId));
    const browserClean = [...sessionsToDelete].every(
      (sessionId) =>
        !window.mmDebug?.terminals?.has(sessionId) &&
        !document.querySelector(`.session-wrapper[data-session-id="${sessionId}"]`),
    );
    return apiClean && browserClean;
  }, 'session stress cleanup');
  perf.scenario.cleanupComplete = true;
}

perf.scenario;
