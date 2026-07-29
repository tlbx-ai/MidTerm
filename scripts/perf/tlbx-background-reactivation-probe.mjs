import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const require = createRequire(import.meta.url);
const {
  chromium,
} = require("../../docs/marketing/ScreenshotAutomation/node_modules/playwright");

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const artifactRoot =
  process.env.TLBX_PERF_ARTIFACT_ROOT ||
  path.join(
    process.env.USERPROFILE || process.env.HOME || repoRoot,
    ".codex",
    "artifacts",
    "chrome-perf",
  );
const stamp = new Date()
  .toISOString()
  .replace(/[-:]/g, "")
  .replace(/\..+/, "")
  .replace("T", "-");
const runDir = path.join(artifactRoot, `${stamp}-tlbx-background-reactivation`);
const profileDir = path.join(runDir, "chrome-profile");
const summaryPath = path.join(runDir, "summary.json");
const cpuProfilePath = path.join(runDir, "cpu-profile.cpuprofile");
const url = process.env.TLBX_PERF_URL || "https://localhost:2000/";
const cookieHeader = process.env.TLBX_COOKIE_HEADER || "";
const cyclesPerLane = Number(process.env.TLBX_PROBE_CYCLES_PER_LANE || 2);
const backgroundMs = Number(process.env.TLBX_PROBE_BACKGROUND_MS || 8000);

await fs.mkdir(profileDir, { recursive: true });

function parseCookies(rawHeader) {
  const target = new URL(url);
  return rawHeader
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separator = part.indexOf("=");
      if (separator <= 0) return null;
      return {
        name: part.slice(0, separator).trim(),
        value: part.slice(separator + 1),
        domain: target.hostname,
        path: "/",
        secure: target.protocol === "https:",
        sameSite: "None",
      };
    })
    .filter(Boolean);
}

async function installPageProbe(page) {
  await page.evaluate(() => {
    const state = {
      startedAt: performance.now(),
      longTasks: [],
      frames: [],
      visibility: [
        {
          at: performance.now(),
          state: document.visibilityState,
          type: "initial",
        },
      ],
      errors: [],
    };
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          state.longTasks.push({
            startTime: entry.startTime,
            duration: entry.duration,
            name: entry.name,
          });
        }
      });
      observer.observe({ type: "longtask", buffered: true });
      state.longTaskObserver = observer;
    } catch (error) {
      state.errors.push(String(error?.message || error));
    }
    document.addEventListener("visibilitychange", () => {
      state.visibility.push({
        at: performance.now(),
        state: document.visibilityState,
        type: "visibilitychange",
      });
    });
    let previous = performance.now();
    const frame = (now) => {
      state.frames.push(now - previous);
      if (state.frames.length > 20_000) state.frames.shift();
      previous = now;
      state.raf = requestAnimationFrame(frame);
    };
    state.raf = requestAnimationFrame(frame);
    window.__tlbxBackgroundProbe = state;
  });
}

async function twoRafWithDeadline(page, timeoutMs = 2500) {
  return page.evaluate(
    (deadlineMs) =>
      new Promise((resolve) => {
        const wallStartedAt = Date.now();
        const perfStartedAt = performance.now();
        let settled = false;
        const finish = (ok) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve({
            ok,
            wallMs: Date.now() - wallStartedAt,
            performanceMs: performance.now() - perfStartedAt,
            visibilityState: document.visibilityState,
          });
        };
        const timeout = setTimeout(() => finish(false), deadlineMs);
        requestAnimationFrame(() => requestAnimationFrame(() => finish(true)));
      }),
    timeoutMs,
  );
}

async function snapshot(page, client, label) {
  await page.evaluate(() => {
    if (typeof globalThis.gc === "function") globalThis.gc();
  });
  await page.waitForTimeout(250);
  const [dom, heap, metrics, browser] = await Promise.all([
    client.send("Memory.getDOMCounters"),
    client.send("Runtime.getHeapUsage"),
    client.send("Performance.getMetrics"),
    page.evaluate(() => {
      const probe = window.__tlbxBackgroundProbe;
      const frames = [...(probe?.frames || [])].sort((a, b) => a - b);
      const percentile = (p) =>
        frames.length
          ? frames[Math.min(frames.length - 1, Math.floor(frames.length * p))]
          : null;
      const visibleTerminal = Array.from(
        document.querySelectorAll(".terminal-container"),
      ).find((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden"
        );
      });
      return {
        visibilityState: document.visibilityState,
        hasFocus: document.hasFocus(),
        activeSessionId: window.mmDebug?.activeId ?? null,
        actionGraphsOpen: !document
          .getElementById("action-graphs-view")
          ?.classList.contains("hidden"),
        graphNodeCount: document.querySelectorAll(".ag-node").length,
        graphEdgeCount: document.querySelectorAll("#action-graphs-edges > *")
          .length,
        xtermCount: document.querySelectorAll(".xterm").length,
        canvasCount: document.querySelectorAll("canvas").length,
        visibleTerminalRect:
          visibleTerminal?.getBoundingClientRect().toJSON() ?? null,
        bodyTextLength: document.body?.innerText?.length ?? 0,
        longTaskCount: probe?.longTasks?.length ?? 0,
        totalLongTaskMs:
          probe?.longTasks?.reduce(
            (total, entry) => total + entry.duration,
            0,
          ) ?? 0,
        maxLongTaskMs:
          probe?.longTasks?.reduce(
            (maximum, entry) => Math.max(maximum, entry.duration),
            0,
          ) ?? 0,
        frameCount: frames.length,
        frameP95Ms: percentile(0.95),
        frameP99Ms: percentile(0.99),
        maxFrameMs: frames.at(-1) ?? null,
        visibilityEvents: probe?.visibility?.length ?? 0,
        observerErrors: probe?.errors ?? [],
      };
    }),
  ]);
  const metricMap = Object.fromEntries(
    metrics.metrics.map((metric) => [metric.name, metric.value]),
  );
  return {
    label,
    capturedAt: new Date().toISOString(),
    dom,
    heap,
    performance: {
      taskDuration: metricMap.TaskDuration ?? null,
      scriptDuration: metricMap.ScriptDuration ?? null,
      layoutDuration: metricMap.LayoutDuration ?? null,
      recalcStyleDuration: metricMap.RecalcStyleDuration ?? null,
    },
    browser,
  };
}

async function measureGraphWheel(page) {
  return page.evaluate(async () => {
    const canvas = document.getElementById("action-graphs-canvas");
    if (!canvas) return { available: false };
    const rect = canvas.getBoundingClientRect();
    const startedAt = performance.now();
    for (let index = 0; index < 240; index += 1) {
      canvas.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
          deltaY: index % 2 === 0 ? 18 : -18,
        }),
      );
    }
    const dispatchMs = performance.now() - startedAt;
    const settle = await new Promise((resolve) => {
      const timeout = setTimeout(() => resolve({ ok: false }), 2500);
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          clearTimeout(timeout);
          resolve({ ok: true });
        }),
      );
    });
    return {
      available: true,
      dispatchMs,
      settled: settle.ok,
    };
  });
}

async function runCycle({
  page,
  blankPage,
  client,
  lane,
  index,
  frozen,
  backgroundMs,
}) {
  await blankPage.bringToFront();
  await blankPage.waitForTimeout(250);
  const hiddenBeforeFreeze = await page.evaluate(
    () => document.visibilityState,
  );
  if (frozen) {
    await client.send("Page.setWebLifecycleState", { state: "frozen" });
  }
  await new Promise((resolve) => setTimeout(resolve, backgroundMs));
  const resumeWallStartedAt = Date.now();
  if (frozen) {
    await client.send("Page.setWebLifecycleState", { state: "active" });
  }
  await page.bringToFront();
  const twoRaf = await twoRafWithDeadline(page);
  const resumeWallMs = Date.now() - resumeWallStartedAt;
  await page.waitForTimeout(500);
  const after = await snapshot(page, client, `${lane}-${index}-after`);
  const wheel = lane === "graph" ? await measureGraphWheel(page) : null;
  const result = {
    lane,
    index,
    frozen,
    backgroundMs,
    hiddenBeforeFreeze,
    resumeWallMs,
    twoRaf,
    wheel,
    after,
  };
  console.log(
    `CYCLE lane=${lane} index=${index} frozen=${frozen} ` +
      `twoRafOk=${twoRaf.ok} twoRafMs=${twoRaf.wallMs} ` +
      `nodes=${after.dom.nodes} listeners=${after.dom.jsEventListeners} ` +
      `longTasks=${after.browser.longTaskCount} maxLongTaskMs=${after.browser.maxLongTaskMs}`,
  );
  return result;
}

async function runStalledRafRecovery(page) {
  const readRendererState = () =>
    page.evaluate(() => {
      const sessionId = window.mmDebug?.activeId ?? null;
      const state = sessionId
        ? window.mmDebug?.terminals?.get(sessionId)
        : null;
      return {
        sessionId,
        hasWebgl: state?.hasWebgl === true,
        terminalCanvasCount:
          state?.container?.querySelectorAll(".xterm-screen canvas").length ??
          0,
      };
    });

  const before = await readRendererState();
  await page.evaluate(() => {
    window.__tlbxProbeOriginalRaf = window.requestAnimationFrame;
    window.requestAnimationFrame = () => 1;
    window.dispatchEvent(new Event("focus"));
  });
  await new Promise((resolve) => setTimeout(resolve, 350));
  const afterWatchdog = await readRendererState();
  await page.evaluate(() => {
    if (window.__tlbxProbeOriginalRaf) {
      window.requestAnimationFrame = window.__tlbxProbeOriginalRaf;
      delete window.__tlbxProbeOriginalRaf;
    }
    window.dispatchEvent(new Event("focus"));
  });
  await page.waitForTimeout(500);
  const afterLaterFocus = await readRendererState();

  const marker = `foreground-dom-recovery-${Date.now()}`;
  const markerRendered = await page.evaluate(
    ({ sessionId, text }) =>
      new Promise((resolve) => {
        const state = window.mmDebug?.terminals?.get(sessionId);
        if (!state) throw new Error("Active terminal state disappeared.");
        const timeout = setTimeout(() => resolve(false), 5000);
        state.terminal.write(`\r\n${text}\r\n`, () => {
          clearTimeout(timeout);
          const buffer = state.terminal.buffer.active;
          const start = Math.max(0, buffer.length - 100);
          for (let index = start; index < buffer.length; index += 1) {
            if (buffer.getLine(index)?.translateToString(true).includes(text)) {
              resolve(true);
              return;
            }
          }
          resolve(
            state.container
              .querySelector(".xterm-rows")
              ?.textContent?.includes(text) ?? false,
          );
        });
      }),
    { sessionId: before.sessionId, text: marker },
  );

  const result = {
    before,
    afterWatchdog,
    afterLaterFocus,
    markerRendered,
    stickyDomFallback:
      before.hasWebgl &&
      !afterWatchdog.hasWebgl &&
      !afterLaterFocus.hasWebgl &&
      afterWatchdog.terminalCanvasCount < before.terminalCanvasCount &&
      afterLaterFocus.terminalCanvasCount === afterWatchdog.terminalCanvasCount,
  };
  console.log(
    `STALL_RECOVERY sticky=${result.stickyDomFallback} ` +
      `webgl=${before.hasWebgl}->${afterWatchdog.hasWebgl}->${afterLaterFocus.hasWebgl} ` +
      `canvases=${before.terminalCanvasCount}->${afterWatchdog.terminalCanvasCount}->${afterLaterFocus.terminalCanvasCount}`,
  );
  return result;
}

let context;
let page;
let createdSessionId = null;
const cycles = [];
try {
  context = await chromium.launchPersistentContext(profileDir, {
    channel: "chrome",
    headless: false,
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1000 },
    args: [
      "--ignore-certificate-errors",
      "--disable-background-networking",
      "--enable-precise-memory-info",
      "--js-flags=--expose-gc",
    ],
  });
  const cookies = parseCookies(cookieHeader);
  if (cookies.length > 0) await context.addCookies(cookies);
  page = context.pages()[0] || (await context.newPage());
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForSelector(".terminal-page", { timeout: 30_000 });
  if ((await page.locator(".session-item[data-session-id]").count()) === 0) {
    createdSessionId = await page.evaluate(async () => {
      const response = await fetch("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cols: 120, rows: 36, shell: "Pwsh" }),
      });
      if (!response.ok)
        throw new Error(`Session create failed: ${response.status}`);
      const created = await response.json();
      return created.id;
    });
    await page.waitForSelector(
      `.session-item[data-session-id="${createdSessionId}"]`,
      { timeout: 15_000 },
    );
  }
  const firstSession = page.locator(".session-item[data-session-id]").first();
  if ((await firstSession.count()) > 0) {
    await firstSession.click();
    await page.locator(".xterm:visible").first().waitFor({ timeout: 15_000 });
  }
  await installPageProbe(page);
  const client = await context.newCDPSession(page);
  await client.send("Performance.enable", { timeDomain: "timeTicks" });
  await client.send("DOM.enable");
  await client.send("Profiler.enable");
  await client.send("Profiler.start");
  const blankPage = await context.newPage();
  await blankPage.goto("about:blank");

  await page.bringToFront();
  await page.waitForTimeout(3000);
  const before = await snapshot(page, client, "before");

  for (let index = 1; index <= cyclesPerLane; index += 1) {
    cycles.push(
      await runCycle({
        page,
        blankPage,
        client,
        lane: "terminal",
        index,
        frozen: index % 2 === 0,
        backgroundMs,
      }),
    );
  }

  const graphButton = page.locator("#btn-action-graphs");
  const graphAvailable =
    (await graphButton.count()) > 0 &&
    !(await graphButton.evaluate((element) =>
      element.classList.contains("hidden"),
    ));
  if (graphAvailable) {
    await graphButton.click();
    await page.waitForSelector("#action-graphs-view:not(.hidden)", {
      timeout: 15_000,
    });
    await page.waitForTimeout(3000);
    for (let index = 1; index <= cyclesPerLane; index += 1) {
      cycles.push(
        await runCycle({
          page,
          blankPage,
          client,
          lane: "graph",
          index,
          frozen: index % 2 === 0,
          backgroundMs,
        }),
      );
    }
  }

  await page.bringToFront();
  if (graphAvailable) {
    await page.locator("#action-graphs-close").click();
    await page.waitForFunction(
      () =>
        document
          .getElementById("action-graphs-view")
          ?.classList.contains("hidden"),
      null,
      { timeout: 5000 },
    );
  }
  const stallRecovery = await runStalledRafRecovery(page);
  await page.waitForTimeout(1000);
  const after = await snapshot(page, client, "after");
  const cpuProfile = await client.send("Profiler.stop");
  await fs.writeFile(
    cpuProfilePath,
    `${JSON.stringify(cpuProfile.profile)}\n`,
    "utf8",
  );
  await page.screenshot({
    path: path.join(runDir, "final.png"),
    fullPage: false,
  });

  const summary = {
    ok:
      cycles.every((cycle) => cycle.twoRaf.ok) &&
      stallRecovery.stickyDomFallback &&
      stallRecovery.markerRendered,
    url,
    runDir,
    summaryPath,
    cpuProfilePath,
    graphAvailable,
    cyclesPerLane,
    backgroundMs,
    createdSessionId,
    before,
    after,
    deltas: {
      heapMB: (after.heap.usedSize - before.heap.usedSize) / 1024 / 1024,
      nodes: after.dom.nodes - before.dom.nodes,
      documents: after.dom.documents - before.dom.documents,
      listeners: after.dom.jsEventListeners - before.dom.jsEventListeners,
      taskDurationMs:
        (after.performance.taskDuration - before.performance.taskDuration) *
        1000,
      scriptDurationMs:
        (after.performance.scriptDuration - before.performance.scriptDuration) *
        1000,
      layoutDurationMs:
        (after.performance.layoutDuration - before.performance.layoutDuration) *
        1000,
      recalcStyleDurationMs:
        (after.performance.recalcStyleDuration -
          before.performance.recalcStyleDuration) *
        1000,
    },
    cycles,
    stallRecovery,
  };
  await fs.writeFile(
    summaryPath,
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
  );
  console.log(`SUMMARY=${summaryPath}`);
  console.log(
    `RESULT ok=${summary.ok} heapDeltaMB=${summary.deltas.heapMB.toFixed(2)} ` +
      `nodesDelta=${summary.deltas.nodes} listenersDelta=${summary.deltas.listeners} ` +
      `taskMs=${summary.deltas.taskDurationMs.toFixed(1)} scriptMs=${summary.deltas.scriptDurationMs.toFixed(1)}`,
  );
} finally {
  if (page && createdSessionId) {
    await page
      .evaluate(
        (sessionId) =>
          fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
            method: "DELETE",
          }),
        createdSessionId,
      )
      .catch(() => {});
  }
  if (context) await context.close();
}
