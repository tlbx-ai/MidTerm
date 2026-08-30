const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(
  predicate,
  timeoutMs = 20000,
  intervalMs = 50,
  label = "handoff",
) {
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

function overlayIsVisible(targetWindow, sessionId) {
  const notice = overlay(targetWindow, sessionId);
  if (!notice?.classList.contains("presentation-visible")) return false;
  const style = targetWindow.getComputedStyle(notice);
  return style.visibility !== "hidden" && Number.parseFloat(style.opacity) > 0.1;
}

function terminalPresentation(targetWindow, sessionId) {
  const container = targetWindow.document.getElementById(
    `terminal-${sessionId}`,
  );
  const notice = overlay(targetWindow, sessionId);
  return {
    role: container?.getAttribute("data-terminal-presentation-role") ?? null,
    epoch: Number(
      container?.getAttribute("data-terminal-presentation-epoch") ?? -1,
    ),
    action:
      container?.getAttribute("data-terminal-presentation-action") ?? null,
    overlayCommitted:
      notice?.classList.contains("presentation-visible") ?? false,
    overlayVisible: overlayIsVisible(targetWindow, sessionId),
  };
}

function noticeGeometry(targetWindow, sessionId) {
  const notice = overlay(targetWindow, sessionId);
  const container = targetWindow.document.getElementById(`terminal-${sessionId}`);
  if (!notice || !container) return null;
  const noticeRect = notice.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  const style = targetWindow.getComputedStyle(notice);
  return {
    viewportWidth: targetWindow.innerWidth,
    viewportHeight: targetWindow.innerHeight,
    width: noticeRect.width,
    height: noticeRect.height,
    rightGap: containerRect.right - noticeRect.right,
    bottomGap: containerRect.bottom - noticeRect.bottom,
    opacity: style.opacity,
    pointerEvents: style.pointerEvents,
    transitionDuration: style.transitionDuration,
  };
}

function installPresentationAudit(targetWindow) {
  const audit = {
    sessionId: null,
    contradictions: [],
    epochRegressions: [],
    blankTerminalFrames: [],
    layoutShifts: [],
    allLayoutShifts: [],
    longTasks: [],
    lastEpochs: new Map(),
    terminalsWithContent: new Set(),
  };

  const inspect = (source) => {
    for (const [id, state] of targetWindow.mmDebug?.terminals ?? []) {
      if (!audit.sessionId || id !== audit.sessionId) continue;
      if (!state.opened || state.container.classList.contains("hidden"))
        continue;
      const presentation = terminalPresentation(targetWindow, id);
      if (!presentation.role) continue;

      if (
        (presentation.role === "owner" && presentation.overlayCommitted) ||
        (presentation.role === "follower" && !presentation.overlayCommitted)
      ) {
        audit.contradictions.push({ id, source, ...presentation });
      }

      const previousEpoch = audit.lastEpochs.get(id);
      if (previousEpoch !== undefined && presentation.epoch < previousEpoch) {
        audit.epochRegressions.push({
          id,
          source,
          previousEpoch,
          ...presentation,
        });
      }
      audit.lastEpochs.set(
        id,
        Math.max(previousEpoch ?? -1, presentation.epoch),
      );

      const buffer = state.terminal.buffer.active;
      let hasVisibleText = false;
      for (let index = 0; index < buffer.length; index += 1) {
        if (buffer.getLine(index)?.translateToString(true).trim()) {
          hasVisibleText = true;
          break;
        }
      }
      if (hasVisibleText) {
        audit.terminalsWithContent.add(id);
      } else if (audit.terminalsWithContent.has(id)) {
        audit.blankTerminalFrames.push({ id, source, ...presentation });
      }
    }
  };

  const mutationObserver = new targetWindow.MutationObserver(() =>
    inspect("mutation"),
  );
  mutationObserver.observe(
    targetWindow.document.querySelector(".terminal-page"),
    {
      attributes: true,
      attributeFilter: [
        "class",
        "style",
        "data-terminal-presentation-role",
        "data-terminal-presentation-epoch",
        "data-terminal-presentation-action",
      ],
      childList: true,
      subtree: true,
    },
  );

  const performanceObserver = new targetWindow.PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.entryType === "layout-shift") {
        audit.allLayoutShifts.push(entry);
        const ownershipChromeMoved = entry.sources?.some((source) => {
          const node = source.node;
          return (
            node instanceof targetWindow.Element &&
            (node.matches(".scaled-overlay") || node.closest(".scaled-overlay"))
          );
        });
        if (ownershipChromeMoved) audit.layoutShifts.push(entry);
      }
      if (entry.entryType === "longtask") audit.longTasks.push(entry);
    }
  });
  performanceObserver.observe({ entryTypes: ["layout-shift", "longtask"] });

  return {
    audit,
    inspect,
    dispose() {
      mutationObserver.disconnect();
      performanceObserver.disconnect();
    },
  };
}

async function selectSession(targetWindow, sessionId) {
  const item = await waitFor(
    () => sessionItem(targetWindow, sessionId),
    20000,
    50,
    "session item",
  );
  item.click();
  await waitFor(
    () => targetWindow.mmDebug?.activeId === sessionId,
    20000,
    50,
    "active session",
  );
  await waitFor(
    () => targetWindow.mmDebug?.terminals?.get(sessionId)?.opened,
    20000,
    50,
    "opened terminal",
  );
}

async function waitForRoles(sessionId, ownerWindow, followerWindow) {
  await waitFor(
    () =>
      terminalPresentation(ownerWindow, sessionId).role === "owner" &&
      !overlayIsVisible(ownerWindow, sessionId) &&
      terminalPresentation(followerWindow, sessionId).role === "follower" &&
      overlayIsVisible(followerWindow, sessionId),
    20000,
    50,
    "owner/follower roles",
  );
}

async function establishOwnership(sessionId, ownerWindow, followerWindow) {
  await waitFor(
    () => {
      const ownerRole = terminalPresentation(ownerWindow, sessionId).role;
      const followerRole = terminalPresentation(followerWindow, sessionId).role;
      return (
        (ownerRole === "owner" && followerRole === "follower") ||
        (ownerRole === "follower" && followerRole === "owner")
      );
    },
    20000,
    50,
    "consistent initial ownership",
  );

  if (terminalPresentation(ownerWindow, sessionId).role !== "owner") {
    await waitFor(
      () => overlayIsVisible(ownerWindow, sessionId),
      20000,
      50,
      "ownership action",
    );
    overlay(ownerWindow, sessionId).click();
  }
  await waitForRoles(sessionId, ownerWindow, followerWindow);
}

async function captureHandoff(
  sessionId,
  sourceWindow,
  ownerWindow,
  followerWindow,
  audits,
) {
  const starts = audits.map(({ audit }) => ({
    layoutShift: audit.layoutShifts.length,
    longTask: audit.longTasks.length,
  }));
  let sampling = true;
  const samples = [];
  const sampleFrames = (async () => {
    while (sampling) {
      await Promise.all(
        audits.map(
          ({ targetWindow }) =>
            new Promise((resolve) =>
              targetWindow.requestAnimationFrame(() => resolve()),
            ),
        ),
      );
      audits.forEach(({ targetWindow, inspect }) => inspect("animation-frame"));
      samples.push({
        desktop: terminalPresentation(window, sessionId),
        mobile: terminalPresentation(popup, sessionId),
      });
    }
  })();

  overlay(sourceWindow, sessionId).click();
  await waitForRoles(sessionId, ownerWindow, followerWindow);
  await sleep(160);
  sampling = false;
  await sampleFrames;

  return {
    frameCount: samples.length,
    layoutShift: audits.map(({ audit }, index) =>
      audit.layoutShifts
        .slice(starts[index].layoutShift)
        .reduce((total, entry) => total + entry.value, 0),
    ),
    maxLongTaskMs: audits.map(({ audit }, index) =>
      audit.longTasks
        .slice(starts[index].longTask)
        .reduce((maximum, entry) => Math.max(maximum, entry.duration), 0),
    ),
  };
}

let popup = null;
let sessionId = null;
const presentationAudits = [];

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
  if (!popup)
    throw new Error("The mobile-sized browser window could not be opened.");
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
  if (!desktopTabId)
    throw new Error("The desktop tab identity was unavailable.");
  presentationAudits.push({
    targetWindow: window,
    ...installPresentationAudit(window),
  });
  presentationAudits.push({
    targetWindow: popup,
    ...installPresentationAudit(popup),
  });

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
    throw new Error(
      `Session creation failed: ${response.status} ${JSON.stringify(body)}`,
    );
  }
  sessionId = body?.session?.id ?? body?.id;
  if (!sessionId) throw new Error("Session creation returned no id.");
  presentationAudits.forEach(({ audit }) => {
    audit.sessionId = sessionId;
  });

  await selectSession(popup, sessionId);
  await selectSession(window, sessionId);
  await establishOwnership(sessionId, popup, window);
  await sleep(750);

  const transitions = [];
  const sample = (label) => {
    transitions.push({
      label,
      desktopFollower: overlayIsVisible(window, sessionId),
      mobileFollower: overlayIsVisible(popup, sessionId),
      desktopCols: window.mmDebug.terminals.get(sessionId).terminal.cols,
      mobileCols: popup.mmDebug.terminals.get(sessionId).terminal.cols,
      desktopNotice: noticeGeometry(window, sessionId),
      mobileNotice: noticeGeometry(popup, sessionId),
    });
  };
  sample("mobile-owner");

  const handoffs = [];
  handoffs.push(
    await captureHandoff(sessionId, window, window, popup, presentationAudits),
  );
  sample("desktop-owner");

  handoffs.push(
    await captureHandoff(sessionId, popup, popup, window, presentationAudits),
  );
  sample("mobile-owner-again");

  for (const transition of transitions) {
    if (transition.desktopFollower === transition.mobileFollower) {
      throw new Error(`Final ownership is ambiguous at ${transition.label}.`);
    }
    const rendered = [
      [transition.desktopFollower, transition.desktopNotice],
      [transition.mobileFollower, transition.mobileNotice],
    ];
    for (const [isFollower, notice] of rendered) {
      const opacity = Number.parseFloat(notice?.opacity ?? "0");
      if ((isFollower && opacity < 0.9) || (!isFollower && opacity > 0.01)) {
        throw new Error(`Final notice opacity contradicts ${transition.label}.`);
      }
      if (
        notice?.viewportWidth <= 768 &&
        (Math.abs(notice.rightGap - 12) > 0.5 ||
          Math.abs(notice.bottomGap - 12) > 0.5 ||
          notice.width > notice.viewportWidth - 24 + 0.5)
      ) {
        throw new Error(
          `Mobile notice is not viewport-docked at ${transition.label}.`,
        );
      }
    }
  }

  for (const { audit } of presentationAudits) {
    if (audit.contradictions.length > 0) {
      throw new Error(
        `Contradictory presentation state: ${JSON.stringify(audit.contradictions)}`,
      );
    }
    if (audit.epochRegressions.length > 0) {
      throw new Error(
        `Presentation epoch regressed: ${JSON.stringify(audit.epochRegressions)}`,
      );
    }
    if (audit.blankTerminalFrames.length > 0) {
      throw new Error(
        `Terminal buffer became blank: ${JSON.stringify(audit.blankTerminalFrames)}`,
      );
    }
  }
  for (const handoff of handoffs) {
    if (handoff.layoutShift.some((value) => value >= 0.01)) {
      throw new Error(
        `Ownership layout shift exceeded budget: ${JSON.stringify(handoff)}`,
      );
    }
    if (handoff.maxLongTaskMs[0] > 50) {
      throw new Error(
        `Desktop handoff long task exceeded budget: ${JSON.stringify(handoff)}`,
      );
    }
  }

  return {
    serviceVersion: await fetch("/api/version").then((value) => value.text()),
    sessionId,
    distinctTabIdentities: desktopTabId !== mobileTabId,
    transitions,
    handoffs,
    presentationAudit: presentationAudits.map(({ audit }) => ({
      contradictions: audit.contradictions.length,
      epochRegressions: audit.epochRegressions.length,
      blankTerminalFrames: audit.blankTerminalFrames.length,
    })),
  };
} finally {
  presentationAudits.forEach(({ dispose }) => dispose());
  if (sessionId) {
    await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    });
    await waitFor(() => !sessionItem(window, sessionId), 10000).catch(
      () => false,
    );
  }
  popup?.close();
  await sleep(500);
}
