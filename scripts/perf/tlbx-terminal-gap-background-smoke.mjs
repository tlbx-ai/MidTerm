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
const runDir = path.join(artifactRoot, `${stamp}-tlbx-terminal-gap-background`);
const profileDir = path.join(runDir, "chrome-profile");
const screenshotPath = path.join(runDir, "terminal-gap-background.png");
const summaryPath = path.join(runDir, "summary.json");
const url = process.env.TLBX_PERF_URL || "https://127.0.0.1:2100/";

await fs.mkdir(profileDir, { recursive: true });

let context;
let ownerContext;
let page;
let ownerPage;
let sessionId;
let summary;

async function waitForTerminal(targetPage, id) {
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

async function ensureTerminalOwner(targetPage, id) {
  const containerSelector = `#terminal-${id}`;
  await targetPage.waitForFunction(
    (targetId) =>
      Boolean(
        document.getElementById(`terminal-${targetId}`)?.dataset
          .terminalPresentationRole,
      ),
    id,
  );
  const role = await targetPage
    .locator(containerSelector)
    .getAttribute("data-terminal-presentation-role");
  if (role !== "owner") {
    await targetPage.locator(`${containerSelector} > .scaled-overlay`).click();
    await targetPage.waitForFunction(
      (targetId) =>
        document.getElementById(`terminal-${targetId}`)?.dataset
          .terminalPresentationRole === "owner",
      id,
    );
  }
}

try {
  context = await chromium.launchPersistentContext(profileDir, {
    channel: "chrome",
    headless: true,
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1000 },
  });
  context.setDefaultTimeout(10_000);
  page = context.pages()[0] || (await context.newPage());
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() =>
    Boolean(window.mmDebug && document.querySelector(".terminal-page")),
  );

  ownerContext = await chromium.launchPersistentContext(
    path.join(runDir, "owner-profile"),
    {
      channel: "chrome",
      headless: true,
      ignoreHTTPSErrors: true,
      viewport: { width: 374, height: 526 },
    },
  );
  ownerContext.setDefaultTimeout(10_000);
  ownerPage = ownerContext.pages()[0] || (await ownerContext.newPage());
  await ownerPage.goto(url, { waitUntil: "domcontentloaded" });
  await ownerPage.waitForFunction(() =>
    Boolean(window.mmDebug && document.querySelector(".terminal-page")),
  );

  sessionId = await ownerPage.evaluate(async () => {
    const response = await fetch("/api/sessions", {
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
    if (!response.ok)
      throw new Error(
        `Session creation failed: ${response.status} ${JSON.stringify(body)}`,
      );
    return body?.session?.id ?? body?.id;
  });

  await waitForTerminal(ownerPage, sessionId);
  await ensureTerminalOwner(ownerPage, sessionId);
  await waitForTerminal(page, sessionId);
  await page.locator(`#terminal-${sessionId} > .scaled-overlay`).waitFor();

  const evidence = await page.evaluate((targetId) => {
    const container = document.getElementById(`terminal-${targetId}`);
    const xterm = container?.querySelector(".xterm");
    const fillers = [
      ...(container?.querySelectorAll(":scope > .terminal-gap-fill") ?? []),
    ];
    const filler = fillers[0] ?? null;
    if (!container || !xterm || !filler)
      throw new Error("Terminal gap presentation is incomplete.");
    const containerRect = container.getBoundingClientRect();
    const xtermRect = xterm.getBoundingClientRect();
    const fillerRect = filler.getBoundingClientRect();
    const fillerStyle = getComputedStyle(filler);
    const containerStyle = getComputedStyle(container);
    const terminalLayers = [
      ".xterm",
      ".xterm-scrollable-element",
      ".xterm-viewport",
      ".xterm-screen",
    ].map((selector) => {
      const element = container.querySelector(selector);
      if (!element) return { selector, missing: true };
      const style = getComputedStyle(element);
      return {
        selector,
        backgroundColor: style.backgroundColor,
        backgroundImage: style.backgroundImage,
        opacity: style.opacity,
      };
    });
    return {
      viewport: { width: innerWidth, height: innerHeight },
      cols: window.mmDebug.terminals.get(targetId).terminal.cols,
      rows: window.mmDebug.terminals.get(targetId).terminal.rows,
      containerRect: {
        left: containerRect.left,
        top: containerRect.top,
        width: containerRect.width,
        height: containerRect.height,
      },
      xtermRect: {
        left: xtermRect.left,
        top: xtermRect.top,
        width: xtermRect.width,
        height: xtermRect.height,
      },
      fillerRect: {
        left: fillerRect.left,
        top: fillerRect.top,
        width: fillerRect.width,
        height: fillerRect.height,
      },
      fillerCount: fillers.length,
      fillerClasses: [...filler.classList],
      fillerBackground: fillerStyle.backgroundImage,
      fillerBackgroundColor: fillerStyle.backgroundColor,
      fillerClipPath: fillerStyle.clipPath,
      terminalCanvasBackgroundStack: containerStyle
        .getPropertyValue("--terminal-canvas-background-stack")
        .trim(),
      terminalThemeBackground:
        window.mmDebug.terminals.get(targetId).terminal.options.theme
          ?.background,
      terminalLayers,
      gapRight: containerStyle
        .getPropertyValue("--terminal-gap-right-width")
        .trim(),
      gapBottom: containerStyle
        .getPropertyValue("--terminal-gap-bottom-height")
        .trim(),
    };
  }, sessionId);

  if (evidence.fillerCount !== 1)
    throw new Error(`Expected one gap surface, found ${evidence.fillerCount}.`);
  if (!evidence.fillerClasses.includes("terminal-gap-fill-surface")) {
    throw new Error("The continuous terminal gap surface is missing.");
  }
  if (!evidence.fillerClipPath.startsWith("polygon("))
    throw new Error("The L-shaped gap clip is missing.");
  if (!evidence.fillerBackground || evidence.fillerBackground === "none") {
    throw new Error("The free pane area has no terminal background.");
  }

  await page.screenshot({ path: screenshotPath });
  summary = { ok: true, url, sessionId, evidence, screenshotPath };
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
  await ownerPage?.close().catch(() => undefined);
  await ownerContext?.close().catch(() => undefined);
  await context?.close().catch(() => undefined);
  if (summary)
    await fs.writeFile(
      summaryPath,
      `${JSON.stringify(summary, null, 2)}\n`,
      "utf8",
    );
}

console.log(JSON.stringify({ ...summary, summaryPath }, null, 2));
