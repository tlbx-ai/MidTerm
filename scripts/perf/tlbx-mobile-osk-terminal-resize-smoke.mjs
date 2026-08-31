import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

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
const runDir = path.join(
  artifactRoot,
  `${stamp}-tlbx-mobile-osk-terminal-resize`,
);
const summaryPath = path.join(runDir, "summary.json");
const screenshotPath = path.join(runDir, "keyboard-visible.png");
const url = process.env.TLBX_PERF_URL || "https://127.0.0.1:2100/";
const maxTransitionMs = Number(process.env.TLBX_OSK_MAX_TRANSITION_MS || 100);

await fs.mkdir(runDir, { recursive: true });

let context;
let page;
let sessionId;
let summary;

async function selectSession(targetPage, id) {
  await targetPage.waitForFunction(
    (targetId) =>
      Boolean(
        document.querySelector(`.session-item[data-session-id="${targetId}"]`),
      ),
    id,
  );
  await targetPage.evaluate((targetId) => {
    document
      .querySelector(`.session-item[data-session-id="${targetId}"]`)
      ?.click();
  }, id);
  await targetPage.waitForFunction(
    (targetId) =>
      window.mmDebug?.activeId === targetId &&
      window.mmDebug?.terminals?.get(targetId)?.opened,
    id,
  );
}

async function ensureOwner(targetPage, id) {
  await targetPage.waitForFunction(
    (targetId) =>
      Boolean(
        document.getElementById(`terminal-${targetId}`)?.dataset
          .terminalPresentationRole,
      ),
    id,
  );
  const selector = `#terminal-${id}`;
  if (
    (await targetPage
      .locator(selector)
      .getAttribute("data-terminal-presentation-role")) !== "owner"
  ) {
    await targetPage.locator(`${selector} > .scaled-overlay`).click();
    await targetPage.waitForFunction(
      (targetId) =>
        document.getElementById(`terminal-${targetId}`)?.dataset
          .terminalPresentationRole === "owner",
      id,
    );
  }
}

async function readGeometry(targetPage, id) {
  return targetPage.evaluate((targetId) => {
    const state = window.mmDebug.terminals.get(targetId);
    const container = document.getElementById(`terminal-${targetId}`);
    const terminalsArea = document.querySelector(".terminals-area");
    const app = document.querySelector(".terminal-page");
    const topbar = document.querySelector(".mobile-topbar");
    const footer = document.querySelector(".adaptive-footer-dock");
    const screen = container?.querySelector(".xterm-screen");
    if (!state || !container || !terminalsArea || !app || !screen) {
      throw new Error("Mobile terminal geometry is incomplete.");
    }
    const rect = (element) => {
      const value = element.getBoundingClientRect();
      return {
        top: value.top,
        bottom: value.bottom,
        width: value.width,
        height: value.height,
      };
    };
    return {
      cols: state.terminal.cols,
      rows: state.terminal.rows,
      container: rect(container),
      terminalsArea: rect(terminalsArea),
      app: rect(app),
      topbar: topbar ? rect(topbar) : null,
      footer: footer ? rect(footer) : null,
      screen: rect(screen),
      scrollTop: container.scrollTop,
      scrollHeight: container.scrollHeight,
      clientHeight: container.clientHeight,
      keyboardVisible: document.body.classList.contains("keyboard-visible"),
      verticalStable: document.body.classList.contains(
        "mobile-terminal-vertical-stable",
      ),
    };
  }, id);
}

async function toggleKeyboard(targetPage, id, visible) {
  const before = await readGeometry(targetPage, id);
  const result = await targetPage.evaluate(
    async ({ targetId, show, previousRows }) => {
      const startedAt = performance.now();
      if (!window.mtDevSoftKeyboard)
        throw new Error("Dev soft keyboard simulator is unavailable.");
      if (show) window.mtDevSoftKeyboard.show(300);
      else window.mtDevSoftKeyboard.hide();

      await new Promise((resolve, reject) => {
        const timeout = window.setTimeout(
          () => reject(new Error("Timed out waiting for terminal rows.")),
          2000,
        );
        const poll = () => {
          const rows =
            window.mmDebug.terminals.get(targetId)?.terminal.rows ??
            previousRows;
          if ((show && rows < previousRows) || (!show && rows > previousRows)) {
            clearTimeout(timeout);
            resolve();
            return;
          }
          requestAnimationFrame(poll);
        };
        poll();
      });

      return performance.now() - startedAt;
    },
    { targetId: id, show: visible, previousRows: before.rows },
  );
  return { elapsedMs: result, geometry: await readGeometry(targetPage, id) };
}

try {
  context = await chromium.launchPersistentContext(
    path.join(runDir, "chrome-profile"),
    {
      channel: "chrome",
      headless: true,
      ignoreHTTPSErrors: true,
      viewport: { width: 390, height: 800 },
    },
  );
  context.setDefaultTimeout(10_000);
  page = context.pages()[0] || (await context.newPage());
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() =>
    Boolean(
      window.mmDebug &&
      window.mtDevSoftKeyboard &&
      document.querySelector(".terminal-page"),
    ),
  );

  sessionId = await page.evaluate(async () => {
    const response = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        shell: "Pwsh",
        workingDirectory: "Q:\\repos\\tlbx-1",
        cols: 42,
        rows: 24,
        launchRequestId: crypto.randomUUID(),
      }),
    });
    const body = await response.json();
    if (!response.ok)
      throw new Error(
        `Session creation failed: ${response.status} ${JSON.stringify(body)}`,
      );
    return body?.session?.id ?? body?.id;
  });

  await selectSession(page, sessionId);
  await ensureOwner(page, sessionId);
  await page.waitForTimeout(100);

  const full = await readGeometry(page, sessionId);
  const keyboard = await toggleKeyboard(page, sessionId, true);
  await page.screenshot({ path: screenshotPath });
  const restored = await toggleKeyboard(page, sessionId, false);
  const stressCycles = [];
  for (let index = 0; index < 10; index += 1) {
    const opened = await toggleKeyboard(page, sessionId, true);
    const closed = await toggleKeyboard(page, sessionId, false);
    stressCycles.push({ openMs: opened.elapsedMs, closeMs: closed.elapsedMs });
  }
  const transitionTimes = [
    keyboard.elapsedMs,
    restored.elapsedMs,
    ...stressCycles.flatMap((cycle) => [cycle.openMs, cycle.closeMs]),
  ];
  const maxObservedTransitionMs = Math.max(...transitionTimes);

  if (keyboard.geometry.cols !== full.cols) {
    throw new Error(
      `OSK changed terminal width: ${full.cols} -> ${keyboard.geometry.cols}.`,
    );
  }
  if (keyboard.geometry.rows >= full.rows) {
    throw new Error(
      `OSK did not reduce terminal rows: ${full.rows} -> ${keyboard.geometry.rows}.`,
    );
  }
  if (keyboard.geometry.verticalStable) {
    throw new Error(
      "OSK incorrectly enabled mobile terminal row preservation.",
    );
  }
  if (maxObservedTransitionMs >= maxTransitionMs) {
    throw new Error(
      `OSK terminal resize exceeded ${maxTransitionMs}ms: max ${maxObservedTransitionMs.toFixed(1)}ms.`,
    );
  }
  if (
    restored.geometry.cols !== full.cols ||
    restored.geometry.rows !== full.rows
  ) {
    throw new Error(
      `Full viewport geometry was not restored: ${full.cols}x${full.rows} -> ${restored.geometry.cols}x${restored.geometry.rows}.`,
    );
  }

  summary = {
    ok: true,
    url,
    sessionId,
    maxTransitionMs,
    full,
    keyboard,
    restored,
    stressCycles,
    maxObservedTransitionMs,
    screenshotPath,
  };
} catch (error) {
  summary = {
    ok: false,
    url,
    sessionId: sessionId ?? null,
    error: error instanceof Error ? error.stack : String(error),
    screenshotPath: null,
  };
  throw error;
} finally {
  if (page && sessionId) {
    await page
      .evaluate(async (targetId) => {
        await fetch(`/api/sessions/${encodeURIComponent(targetId)}`, {
          method: "DELETE",
        });
      }, sessionId)
      .catch(() => undefined);
  }
  await context?.close().catch(() => undefined);
  if (summary)
    await fs.writeFile(
      summaryPath,
      `${JSON.stringify(summary, null, 2)}\n`,
      "utf8",
    );
}

console.log(JSON.stringify({ ...summary, summaryPath }, null, 2));
