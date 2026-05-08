const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const raf = () => new Promise((resolve) => requestAnimationFrame(resolve));
const twoRaf = async () => {
  await raf();
  await raf();
};

async function waitFor(predicate, timeoutMs = 15000, intervalMs = 100) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error('Timed out waiting for scenario condition.');
}

async function requestJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 10000);
  try {
    const response = await fetch(url, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`${options.method || 'GET'} ${url} failed: ${response.status}`);
    }
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSessionIds() {
  const response = await requestJson('/api/sessions', { timeoutMs: 12000 });
  return new Set((response?.sessions || []).map((session) => session.id).filter(Boolean));
}

function sessionItem(sessionId) {
  return document.querySelector(`.session-item[data-session-id="${CSS.escape(sessionId)}"]`);
}

function collectDomCounts() {
  const selectors = [
    '.session-item',
    '[data-session-id]',
    '.session-terminal-wrapper',
    '.terminal-container',
    '.xterm',
    '.xterm-screen',
    '.xterm-rows > div',
    '.xterm-viewport',
    '.session-tab-bar',
    '.layout-pane',
    '[data-tab-panel]',
  ];
  return Object.fromEntries(selectors.map((selector) => [selector, document.querySelectorAll(selector).length]));
}

async function switchToSession(sessionId) {
  const item = await waitFor(() => sessionItem(sessionId), 10000);
  const started = performance.now();
  item.scrollIntoView({ block: 'nearest' });
  item.click();
  await waitFor(() => window.mmDebug?.activeId === sessionId, 8000, 50);
  await twoRaf();
  return performance.now() - started;
}

async function createSessionViaUi(knownIds) {
  const button =
    document.getElementById('btn-new-session') ||
    document.getElementById('btn-create-terminal') ||
    document.getElementById('btn-new-session-mobile');
  if (!button) {
    throw new Error('No New Session button found.');
  }

  button.click();
  let launcherClicked = false;
  const sessionId = await waitFor(async () => {
    const ids = await fetchSessionIds();
    for (const id of ids) {
      if (!knownIds.has(id)) {
        knownIds.add(id);
        return id;
      }
    }

    if (!launcherClicked) {
      const launcherAction = document.querySelector(
        '.session-launcher-provider-action[data-provider="terminal"][data-launch-mode="new"]',
      );
      if (launcherAction instanceof HTMLElement && !launcherAction.hasAttribute('disabled')) {
        launcherClicked = true;
        launcherAction.scrollIntoView({ block: 'nearest' });
        launcherAction.click();
      }
    }

    return null;
  }, 20000, 250);

  await waitFor(() => sessionItem(sessionId), 20000);
  return sessionId;
}

async function main() {
  const result = {
    startedAt: new Date().toISOString(),
    href: location.href,
    title: document.title,
    userAgent: navigator.userAgent,
    visibilityState: document.visibilityState,
    serviceVersion: null,
    appVersionText: null,
    settingsFrontendVersionText: null,
    visibleVersionTexts: [],
    initialDomCounts: null,
    finalDomCounts: null,
    createdSessionIds: [],
    switchDurationsMs: [],
    outputCommands: 0,
    xtermCountPeak: 0,
    cleanupDeleted: 0,
    step: 'init',
  };

  window.__midtermPerfScenario = result;
  await waitFor(() => window.mmDebug && document.querySelector('.terminal-page'), 20000);
  result.serviceVersion = await fetch('/api/version').then((response) => response.text());
  result.appVersionText = document.getElementById('app-version')?.textContent?.trim() || null;
  result.settingsFrontendVersionText =
    document.getElementById('version-frontend')?.textContent?.trim() || null;
  result.visibleVersionTexts = Array.from(
    new Set((document.body?.innerText.match(/(?:v)?9\.8\.\d+(?:-dev)?/g) || []).slice(-12)),
  );
  result.initialDomCounts = collectDomCounts();

  try {
    result.step = 'create-sessions';
    const knownIds = await fetchSessionIds();
    for (let i = 0; i < 3; i += 1) {
      const sessionId = await createSessionViaUi(knownIds);
      result.createdSessionIds.push(sessionId);
      await requestJson(`/api/sessions/${encodeURIComponent(sessionId)}/name`, {
        method: 'PUT',
        body: JSON.stringify({ name: `perf-terminal-${i + 1}` }),
      });
    }

    result.step = 'emit-output';
    for (const [index, sessionId] of result.createdSessionIds.entries()) {
      const command =
        "$ProgressPreference='SilentlyContinue'; " +
        `1..900 | ForEach-Object { "perf-${index + 1}-$($_) " + ('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' * 3) }; ` +
        "'done'";
      await requestJson(`/api/sessions/${encodeURIComponent(sessionId)}/input/text`, {
        method: 'POST',
        body: JSON.stringify({ text: command, appendNewline: true }),
      });
      result.outputCommands += 1;
    }

    await sleep(2500);

    result.step = 'switch-standalone';
    for (let i = 0; i < 45; i += 1) {
      const sessionId = result.createdSessionIds[i % result.createdSessionIds.length];
      result.switchDurationsMs.push(await switchToSession(sessionId));
      result.xtermCountPeak = Math.max(result.xtermCountPeak, document.querySelectorAll('.xterm').length);
    }

    if (result.createdSessionIds.length >= 2 && window.mmDebug?.layout?.dock) {
      result.step = 'dock-switch';
      window.mmDebug.layout.dock(result.createdSessionIds[0], result.createdSessionIds[1], 'right');
      await twoRaf();
      for (let i = 0; i < 12; i += 1) {
        const sessionId = result.createdSessionIds[i % 2];
        const started = performance.now();
        window.mmDebug.layout.focus(sessionId);
        await twoRaf();
        result.switchDurationsMs.push(performance.now() - started);
      }
    }

    result.xtermCountPeak = Math.max(result.xtermCountPeak, document.querySelectorAll('.xterm').length);
    result.step = 'complete';
    result.completedAt = new Date().toISOString();
    return result;
  } finally {
    result.step = `cleanup-after-${result.step}`;
    for (const sessionId of result.createdSessionIds) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
          method: 'DELETE',
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (response.ok) result.cleanupDeleted += 1;
      } catch {
        // Best-effort cleanup. The scenario result records how many sessions were deleted.
      }
    }
    await sleep(1000);
    const durations = [...result.switchDurationsMs].sort((a, b) => a - b);
    const percentile = (p) => durations.length
      ? durations[Math.min(durations.length - 1, Math.floor(durations.length * p))]
      : null;
    result.switchStats = {
      count: durations.length,
      p50Ms: percentile(0.5),
      p95Ms: percentile(0.95),
      maxMs: durations.length ? durations[durations.length - 1] : null,
    };
    result.finalDomCounts = collectDomCounts();
    if (window.__codexChromePerf) {
      window.__codexChromePerf.scenario = result;
    }
  }
}

return await Promise.race([
  main(),
  new Promise((_, reject) => setTimeout(() => reject(new Error('MidTerm terminal stress scenario timeout')), 75000)),
]);
