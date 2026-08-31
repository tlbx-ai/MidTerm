const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 20000, intervalMs = 75) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error("Timed out waiting for the size-control overlay scenario.");
}

function rect(element) {
  const value = element.getBoundingClientRect();
  return {
    top: value.top,
    right: value.right,
    bottom: value.bottom,
    left: value.left,
    width: value.width,
    height: value.height,
  };
}

function sessionItem(targetWindow, sessionId) {
  return targetWindow.document.querySelector(
    `.session-item[data-session-id="${targetWindow.CSS.escape(sessionId)}"]`,
  );
}

async function selectSession(targetWindow, sessionId) {
  const item = await waitFor(() => sessionItem(targetWindow, sessionId));
  item.click();
  await waitFor(() => targetWindow.mmDebug?.activeId === sessionId);
  await waitFor(() => targetWindow.mmDebug?.terminals?.get(sessionId)?.opened);
}

let popup = null;
let sessionId = null;

try {
  await waitFor(
    () => window.mmDebug && document.querySelector(".terminal-page"),
  );

  popup = window.open(
    location.href,
    `tlbx-size-owner-${Date.now()}`,
    "popup=yes,width=390,height=844,left=20,top=20",
  );
  if (!popup) throw new Error("The narrow owner window could not be opened.");

  await waitFor(() => {
    try {
      return popup.mmDebug && popup.document.querySelector(".terminal-page");
    } catch {
      return false;
    }
  });

  popup.resizeTo(390, 844);
  await sleep(350);

  const launchRequestId = crypto.randomUUID();
  const response = await popup.fetch("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      shell: "Pwsh",
      workingDirectory: "Q:\\repos\\tlbx-1",
      cols: 42,
      rows: 22,
      launchRequestId,
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

  await selectSession(popup, sessionId);
  await waitFor(() => {
    const container = popup.document.getElementById(`terminal-${sessionId}`);
    return container && !container.classList.contains("scaled");
  });

  await waitFor(() => sessionItem(window, sessionId));
  await selectSession(window, sessionId);

  const overlay = await waitFor(() =>
    document.querySelector(
      `#terminal-${CSS.escape(sessionId)} > .scaled-overlay`,
    ),
  );
  await waitFor(() => overlay.textContent?.includes("Continue working here"));

  const container = document.getElementById(`terminal-${sessionId}`);
  const xterm = container.querySelector(".xterm");
  const gapFillers = [
    ...container.querySelectorAll(":scope > .terminal-gap-fill"),
  ];
  const gapFiller = gapFillers[0] ?? null;
  const containerRect = rect(container);
  const overlayRect = rect(overlay);
  const xtermRect = rect(xterm);
  const style = getComputedStyle(container);
  const gapFillerStyle = gapFiller ? getComputedStyle(gapFiller) : null;
  const rightOffset = containerRect.right - overlayRect.right;
  const bottomOffset = containerRect.bottom - overlayRect.bottom;

  const result = {
    serviceVersion: await fetch("/api/version").then((value) => value.text()),
    sessionId,
    desktopViewport: { width: innerWidth, height: innerHeight },
    ownerViewport: { width: popup.innerWidth, height: popup.innerHeight },
    terminal: {
      cols: window.mmDebug.terminals.get(sessionId).terminal.cols,
      rows: window.mmDebug.terminals.get(sessionId).terminal.rows,
    },
    containerRect,
    xtermRect,
    overlayRect,
    terminalGapRightWidth: style
      .getPropertyValue("--terminal-gap-right-width")
      .trim(),
    terminalGapBottomHeight: style
      .getPropertyValue("--terminal-gap-bottom-height")
      .trim(),
    gapFillerCount: gapFillers.length,
    gapFillerClasses: gapFiller ? [...gapFiller.classList] : [],
    gapFillerRect: gapFiller ? rect(gapFiller) : null,
    gapFillerBackground: gapFillerStyle?.backgroundImage ?? null,
    gapFillerClipPath: gapFillerStyle?.clipPath ?? null,
    overlayClasses: [...overlay.classList],
    overlayParentId: overlay.parentElement?.id ?? null,
    rightOffset,
    bottomOffset,
  };

  if (result.overlayParentId !== `terminal-${sessionId}`) {
    throw new Error("The overlay is not owned by the terminal pane.");
  }
  if (result.overlayClasses.includes("terminal-gap-right")) {
    throw new Error("The shell overlay moved into the xterm right-hand gap.");
  }
  if (result.overlayClasses.includes("terminal-gap-bottom")) {
    throw new Error("The shell overlay moved into the xterm bottom gap.");
  }
  if (Math.abs(rightOffset - 8) > 1) {
    throw new Error(
      `The overlay is not docked to the shell's right edge: ${rightOffset}px.`,
    );
  }
  if (Math.abs(bottomOffset - 8) > 1) {
    throw new Error(
      `The overlay is not docked to the shell's bottom edge: ${bottomOffset}px.`,
    );
  }
  if (xtermRect.width >= containerRect.width - 100) {
    throw new Error(
      "The scenario did not produce a meaningful narrow-owner xterm gap.",
    );
  }
  if (result.gapFillerCount !== 1) {
    throw new Error(
      `Expected one continuous terminal gap surface, found ${result.gapFillerCount}.`,
    );
  }
  if (!result.gapFillerClasses.includes("terminal-gap-fill-surface")) {
    throw new Error(
      "The terminal gap is not painted by the continuous surface.",
    );
  }
  if (
    Math.abs(result.gapFillerRect.left - containerRect.left) > 0.25 ||
    Math.abs(result.gapFillerRect.top - containerRect.top) > 0.25 ||
    Math.abs(result.gapFillerRect.width - containerRect.width) > 0.25 ||
    Math.abs(result.gapFillerRect.height - containerRect.height) > 0.25
  ) {
    throw new Error(
      "The terminal gap surface does not cover the complete pane.",
    );
  }
  if (!result.gapFillerClipPath?.startsWith("polygon(")) {
    throw new Error(
      "The terminal gap surface has no continuous L-shaped clip.",
    );
  }
  if (!result.gapFillerBackground || result.gapFillerBackground === "none") {
    throw new Error(
      "The terminal gap surface did not receive the terminal background.",
    );
  }

  return result;
} finally {
  if (sessionId) {
    await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    });
    await waitFor(() => !sessionItem(window, sessionId), 10000).catch(
      () => false,
    );
  }
  popup?.close();
  await sleep(750);
}
