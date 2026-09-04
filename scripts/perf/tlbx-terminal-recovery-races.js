// Run with the chrome-perf script scenario against an isolated source instance.
const evidence = { cycles: [], sessions: [], cleanup: false };
window.__codexChromePerf.scenario = evidence;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function api(path, body, method = "POST") {
  const response = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}
async function until(predicate, label) {
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await delay(25);
  }
  throw new Error(`Timed out: ${label}`);
}
function contains(id, marker) {
  const buffer = window.mmDebug?.terminals.get(id)?.terminal.buffer.active;
  if (!buffer) return false;
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer.getLine(i)?.translateToString(true).includes(marker))
      return true;
  }
  return false;
}
try {
  for (let index = 0; index < 2; index += 1) {
    const session = await api("/api/sessions", {
      shell: "Pwsh",
      cols: 100,
      rows: 28,
    });
    evidence.sessions.push(session.id);
    await until(
      () =>
        document.querySelector(
          `.session-item[data-session-id="${session.id}"]`,
        ),
      "session row",
    );
    document
      .querySelector(`.session-item[data-session-id="${session.id}"]`)
      .click();
    await until(
      () => window.mmDebug?.terminals.get(session.id)?.opened,
      "terminal open",
    );
    await api(`/api/sessions/${session.id}/input/text`, {
      text: `Write-Output ('READY_' + '${session.id}')`,
      appendNewline: true,
    });
    await until(
      () => contains(session.id, `READY_${session.id}`),
      "initial terminal output",
    );
  }
  for (let cycle = 0; cycle < 10; cycle += 1) {
    // A foreground recovery followed by a second lifecycle inside its 250ms
    // coalescing window used to leave the actual mux permanently suspended.
    await delay(300);
    window.dispatchEvent(new Event("focus"));
    await delay(20);
    window.dispatchEvent(new PageTransitionEvent("pagehide"));
    window.dispatchEvent(new PageTransitionEvent("pageshow"));
    const started = performance.now();
    for (const id of evidence.sessions) {
      const marker = `RECOVERED_${cycle}_${id}`;
      await api(`/api/sessions/${id}/input/text`, {
        text: `Write-Output ('RECOVERED_' + '${cycle}_${id}')`,
        appendNewline: true,
      });
      await until(() => contains(id, marker), marker);
      await until(() => {
        const state = window.mmDebug.transport(id);
        return (
          state &&
          state.receivedSeq === state.submittedSeq &&
          state.submittedSeq === state.renderedSeq
        );
      }, "received/submitted/rendered convergence");
      evidence.cycles.push({
        cycle,
        id,
        elapsedMs: performance.now() - started,
        transport: JSON.parse(
          JSON.stringify(window.mmDebug.transport(id), (_, value) =>
            typeof value === "bigint" ? value.toString() : value,
          ),
        ),
      });
    }
  }
  const visible = window.mmDebug.terminals.get(window.mmDebug.activeId);
  if (!visible?.container.getBoundingClientRect().height)
    throw new Error("Active terminal is not visible");
  evidence.ok = true;
} finally {
  for (const id of evidence.sessions)
    await api(`/api/sessions/${id}`, undefined, "DELETE");
  evidence.cleanup = true;
}
