const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 15000, intervalMs = 50) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error("Timed out waiting for background preview focus condition.");
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `${options.method || "GET"} ${url} failed: ${response.status} ${text}`,
    );
  }
  return text ? JSON.parse(text) : null;
}

async function createSession() {
  const launchRequestId =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `focus-smoke-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const response = await requestJson("/api/sessions", {
    method: "POST",
    body: JSON.stringify({
      shell: "Pwsh",
      workingDirectory: "Q:\\repos\\tlbx-1",
      cols: 120,
      rows: 30,
      launchRequestId,
    }),
  });
  const sessionId = response?.session?.id ?? response?.id;
  if (!sessionId) throw new Error("Session creation returned no id.");
  return sessionId;
}

function sessionItem(sessionId) {
  return document.querySelector(
    `.session-item[data-session-id="${CSS.escape(sessionId)}"]`,
  );
}

async function selectSession(sessionId) {
  const item = await waitFor(() => sessionItem(sessionId));
  item.click();
  await waitFor(() => window.mmDebug?.activeId === sessionId);
}

async function openPreview(sessionId, previewName, activateSession) {
  const response = await fetch("/api/browser/open", {
    headers: { "Content-Type": "application/json" },
    method: "POST",
    body: JSON.stringify({
      sessionId,
      previewName,
      url: "https://example.com/",
      activateSession,
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`POST /api/browser/open failed: ${response.status} ${text}`);
  }
  return text;
}

const createdSessionIds = [];
const result = {
  activeBefore: null,
  activeAfterBackgroundOpen: null,
  activeAfterExplicitActivation: null,
  hiddenFrameAttached: false,
  backgroundControllable: false,
  backgroundVisible: null,
  dockVisibilityPreserved: false,
};

try {
  const foregroundSessionId = await createSession();
  const backgroundSessionId = await createSession();
  createdSessionIds.push(foregroundSessionId, backgroundSessionId);
  await waitFor(
    () => sessionItem(foregroundSessionId) && sessionItem(backgroundSessionId),
  );
  await selectSession(foregroundSessionId);

  const dock = document.getElementById("web-preview-dock");
  const dockWasHidden = dock?.classList.contains("hidden") ?? true;
  result.activeBefore = window.mmDebug?.activeId ?? null;

  await openPreview(backgroundSessionId, "focus-smoke", false);
  await waitFor(() => {
    const frame = document.querySelector(
      `.web-preview-iframe[data-preview-frame-key="${CSS.escape(backgroundSessionId)}::focus-smoke"]`,
    );
    return frame?.classList.contains("hidden") ? frame : null;
  });

  const status = await requestJson(
    `/api/browser/status?sessionId=${encodeURIComponent(backgroundSessionId)}&previewName=focus-smoke`,
  );
  result.activeAfterBackgroundOpen = window.mmDebug?.activeId ?? null;
  result.hiddenFrameAttached = true;
  result.backgroundControllable = status?.controllable === true;
  result.backgroundVisible = status?.defaultClient?.isVisible ?? null;
  result.dockVisibilityPreserved =
    (dock?.classList.contains("hidden") ?? true) === dockWasHidden;

  if (result.activeAfterBackgroundOpen !== foregroundSessionId) {
    throw new Error("Background preview changed the active tlbx session.");
  }
  if (!result.backgroundControllable || result.backgroundVisible !== false) {
    throw new Error(
      "Background preview did not attach as a hidden controllable client.",
    );
  }
  if (!result.dockVisibilityPreserved) {
    throw new Error("Background preview changed the visible dock state.");
  }

  await openPreview(backgroundSessionId, "focus-smoke", true);
  await waitFor(() => window.mmDebug?.activeId === backgroundSessionId);
  result.activeAfterExplicitActivation = window.mmDebug?.activeId ?? null;

  return result;
} finally {
  await Promise.allSettled(
    createdSessionIds.map((sessionId) =>
      fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
      }),
    ),
  );
}
