const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 20000, intervalMs = 50, label = "handoff") {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function sessionItem(targetWindow, sessionId) {
  return targetWindow.document.querySelector(
    `.session-item[data-session-id="${targetWindow.CSS.escape(sessionId)}"]`,
  );
}

function overlay(targetWindow, sessionId) {
  return targetWindow.document.querySelector(
    `#terminal-${targetWindow.CSS.escape(sessionId)} > .scaled-overlay`,
  );
}

async function selectSession(targetWindow, sessionId) {
  const item = await waitFor(() => sessionItem(targetWindow, sessionId), 20000, 50, "session item");
  item.click();
  await waitFor(() => targetWindow.mmDebug?.activeId === sessionId, 20000, 50, "active session");
  await waitFor(
    () => targetWindow.mmDebug?.terminals?.get(sessionId)?.opened,
    20000,
    50,
    "opened terminal",
  );
}

async function waitForRoles(sessionId, ownerWindow, followerWindow) {
  await waitFor(
    () => !overlay(ownerWindow, sessionId) && overlay(followerWindow, sessionId),
    20000,
    50,
    "owner/follower roles",
  );
}

let popup = null;
let sessionId = null;

try {
  await waitFor(
    () => window.mmDebug && document.querySelector(".terminal-page"),
    20000,
    50,
    "desktop shell",
  );
  const desktopTabId = sessionStorage.getItem("mt-tab-id");

  popup = window.open(
    location.href,
    `tlbx-handoff-${Date.now()}`,
    "popup=yes,width=390,height=844,left=20,top=20",
  );
  if (!popup) throw new Error("The mobile-sized browser window could not be opened.");
  await waitFor(
    () => {
      try {
        return popup.mmDebug && popup.document.querySelector(".terminal-page");
      } catch {
        return false;
      }
    },
    20000,
    50,
    "mobile shell",
  );

  const mobileTabId = await waitFor(
    () => {
      const candidate = popup.sessionStorage.getItem("mt-tab-id");
      return candidate && candidate !== desktopTabId ? candidate : null;
    },
    5000,
    25,
    "distinct tab identities",
  );
  if (!desktopTabId) throw new Error("The desktop tab identity was unavailable.");

  const response = await popup.fetch("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      shell: "Pwsh",
      workingDirectory: "Q:\\repos\\tlbx-1",
      cols: 42,
      rows: 22,
      launchRequestId: crypto.randomUUID(),
    }),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`Session creation failed: ${response.status} ${JSON.stringify(body)}`);
  }
  sessionId = body?.session?.id ?? body?.id;
  if (!sessionId) throw new Error("Session creation returned no id.");

  await selectSession(popup, sessionId);
  await selectSession(window, sessionId);
  await waitForRoles(sessionId, popup, window);
  await sleep(750);

  const transitions = [];
  const sample = (label) => {
    transitions.push({
      label,
      desktopFollower: Boolean(overlay(window, sessionId)),
      mobileFollower: Boolean(overlay(popup, sessionId)),
      desktopCols: window.mmDebug.terminals.get(sessionId).terminal.cols,
      mobileCols: popup.mmDebug.terminals.get(sessionId).terminal.cols,
    });
  };
  sample("mobile-owner");

  overlay(window, sessionId).click();
  await waitForRoles(sessionId, window, popup);
  await sleep(750);
  sample("desktop-owner");

  overlay(popup, sessionId).click();
  await waitForRoles(sessionId, popup, window);
  await sleep(750);
  sample("mobile-owner-again");

  for (const transition of transitions) {
    if (transition.desktopFollower === transition.mobileFollower) {
      throw new Error(`Final ownership is ambiguous at ${transition.label}.`);
    }
  }

  return {
    serviceVersion: await fetch("/api/version").then((value) => value.text()),
    sessionId,
    distinctTabIdentities: desktopTabId !== mobileTabId,
    transitions,
  };
} finally {
  if (sessionId) {
    await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
    await waitFor(() => !sessionItem(window, sessionId), 10000).catch(() => false);
  }
  popup?.close();
  await sleep(500);
}
