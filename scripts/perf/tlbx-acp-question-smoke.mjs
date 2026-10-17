import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

// Uses an existing live acceptance session; never starts a paid provider turn.
const require = createRequire(import.meta.url);
const {
  chromium,
} = require("../../docs/marketing/ScreenshotAutomation/node_modules/playwright");
const url = process.env.TLBX_PERF_URL;
const cookie = process.env.TLBX_COOKIE_HEADER;
const sessionId = process.env.TLBX_ACP_UI_SESSION_ID;
const answer = process.env.TLBX_ACP_UI_ANSWER === "true";
const cancel = process.env.TLBX_ACP_UI_SCENARIO === "cancel";
const multi = cancel || process.env.TLBX_ACP_UI_SCENARIO === "multi";
const resume = process.env.TLBX_ACP_UI_SCENARIO === "resume";
const nativeV2 = process.env.TLBX_ACP_UI_SCENARIO === "v2";
const planReview = process.env.TLBX_ACP_UI_SCENARIO === "plan";
const nativeConfig = process.env.TLBX_ACP_UI_SCENARIO === "config";
const nativeCommands = process.env.TLBX_ACP_UI_SCENARIO === "commands";
const nativeUsage = process.env.TLBX_ACP_UI_SCENARIO === "usage";
assert.ok(
  url && cookie && sessionId,
  "Authenticated source URL and acceptance session required",
);
const out = path.resolve(
  process.env.TLBX_PERF_ARTIFACT_ROOT || ".dev/acp-parity/question-browser",
);
fs.mkdirSync(out, { recursive: true });
const profile = fs.mkdtempSync(path.join(out, "chrome-profile-"));
const result = {
  ok: false,
  answered: answer,
  sessionId,
  screenshots: [],
  measurements: [],
  errors: [],
};
let chrome, browser, context, page;
let resolvePlanSubmission;
const planSubmission = new Promise((resolve) => {
  resolvePlanSubmission = resolve;
});
try {
  chrome = spawn(
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    [
      "--headless=new",
      "--remote-debugging-port=0",
      "--user-data-dir=" + profile,
      "--ignore-certificate-errors",
      "--no-first-run",
      "--no-default-browser-check",
    ],
    {
      windowsHide: true,
      stdio: [
        "ignore",
        fs.openSync(path.join(out, "chrome.stdout.log"), "w"),
        fs.openSync(path.join(out, "chrome.stderr.log"), "w"),
      ],
    },
  );
  fs.writeFileSync(path.join(out, "chrome.pid"), String(chrome.pid));
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const port = Number(
        fs
          .readFileSync(path.join(profile, "DevToolsActivePort"), "utf8")
          .split("\n")[0],
      );
      browser = await chromium.connectOverCDP("http://127.0.0.1:" + port);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.ok(browser, "Chrome started");
  context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1000 },
  });
  const eq = cookie.indexOf("=");
  await context.addCookies([
    { name: cookie.slice(0, eq), value: cookie.slice(eq + 1), url },
  ]);
  page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on("pageerror", (error) => result.errors.push(error.message));
  if (nativeConfig)
    page.on("request", (request) => {
      if (
        request.method() !== "POST" ||
        new URL(request.url()).pathname !== "/api/command-bay/queue"
      )
        return;
      const body = request.postDataJSON();
      if (body.sessionId === sessionId && body.turn)
        resolvePlanSubmission(body.turn);
    });
  if (planReview || nativeConfig || nativeCommands)
    page.on("websocket", (socket) =>
      socket.on("framesent", (frame) => {
        try {
          const message = JSON.parse(String(frame.payload));
          if (
            message.action === "turn.submit" &&
            message.sessionId === sessionId
          )
            resolvePlanSubmission(message.turn);
        } catch {
          /* Other application sockets may carry binary frames. */
        }
      }),
    );
  await page.goto(url);
  // Hover actions cover the center of long truncated titles; the row's left
  // selection area remains the normal pointer target beside those controls.
  await page
    .locator(`.session-item[data-session-id="${sessionId}"]`)
    .click({ position: { x: 24, y: 20 } });
  const wrapper = page.locator(
    `.session-wrapper[data-session-id="${sessionId}"]`,
  );
  const initialResponse = await context.request.get(
    `${url}/api/sessions/${sessionId}/agent-control/history?count=96`,
  );
  assert.ok(initialResponse.ok(), "Canonical agent state is readable");
  const initial = await initialResponse.json();
  const initiallyOpen = initial.requests.some(
    (request) => request.kind === "interview" && request.state === "open",
  );
  result.initiallyOpen = initiallyOpen;
  if (resume) {
    assert.equal(initiallyOpen, false, "Loaded interviews are historical");
    assert.equal(
      initial.thread.threadId,
      process.env.TLBX_ACP_UI_EXPECTED_THREAD,
    );
    assert.equal(initial.currentTurn.state, "completed");
    for (const viewport of [
      { width: 1440, height: 1000 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      const recalled = wrapper.getByText("TLBX_NATIVE_RESUME_BLUE_74", {
        exact: true,
      });
      await recalled.scrollIntoViewIfNeeded();
      await recalled.waitFor({ state: "visible" });
      const oldAnswer = wrapper.getByText("TLBX_GROK_QUESTION_OK_73", {
        exact: true,
      });
      await oldAnswer.scrollIntoViewIfNeeded();
      await oldAnswer.waitFor({ state: "visible" });
      assert.equal(await page.evaluate(() => document.hidden), false);
      const screenshot = path.join(out, `resume-${viewport.width}.png`);
      await page.screenshot({ path: screenshot });
      result.screenshots.push(screenshot);
    }
    result.nativeResumeVerified = true;
  }
  if (nativeV2) {
    assert.equal(initial.currentTurn.state, "completed");
    assert.equal(initiallyOpen, false);
    for (let opened = 0; opened < 20; opened++) {
      const closed = wrapper.locator("details:not([open]) > summary");
      if ((await closed.count()) === 0) break;
      await closed.first().click();
    }
    await wrapper
      .getByText("Correct answer.", { exact: true })
      .waitFor({ state: "visible" });
    assert.equal(await wrapper.getByText(/Obsolete/).count(), 0);
    assert.equal(await wrapper.getByText(/Must be cleared/).count(), 0);
    for (const viewport of [
      { width: 1440, height: 1000 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await wrapper
        .getByText("Correct answer.", { exact: true })
        .scrollIntoViewIfNeeded();
      const screenshot = path.join(out, `acpv2-${viewport.width}.png`);
      await page.screenshot({ path: screenshot });
      result.screenshots.push(screenshot);
    }
    result.v2RenderingVerified = true;
  }
  if (planReview) {
    const sessionList = await (
      await context.request.get(`${url}/api/sessions`)
    ).json();
    const sessionInfo = sessionList.sessions.find(
      (session) => session.id === sessionId,
    );
    assert.equal(
      sessionInfo.profileHint,
      "acp-plan-test",
      "Implementation clicks require the deterministic test provider",
    );
    const proposal = initial.history.find(
      (item) =>
        item.itemType === "proposed_plan" &&
        item.turnId === initial.currentTurn.turnId,
    );
    assert.ok(proposal, "Native proposed plan is retained");
    const implement = wrapper.locator(".agent-plan-implement").last();
    await implement.waitFor({ state: "visible" });
    assert.equal(
      await implement.isDisabled(),
      true,
      "Implementation waits for settled native work",
    );
    assert.equal(
      await implement
        .locator("xpath=ancestor::article")
        .getAttribute("data-artifact-position"),
      null,
      "Proposal is outside work-log clusters",
    );
    for (const viewport of [
      { width: 1440, height: 1000 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await implement.scrollIntoViewIfNeeded();
      const box = await implement.boundingBox();
      assert.ok(
        box &&
          box.height >= 44 &&
          box.x >= 0 &&
          box.x + box.width <= viewport.width,
      );
      result.measurements.push({
        viewport,
        button: box,
        disabled: await implement.isDisabled(),
      });
      const screenshot = path.join(out, `plan-${viewport.width}.png`);
      await page.screenshot({ path: screenshot });
      result.screenshots.push(screenshot);
    }
    await page.waitForFunction(
      () => {
        const button = [
          ...document.querySelectorAll(".agent-plan-implement"),
        ].at(-1);
        return button && !button.disabled;
      },
      null,
      { timeout: 30000 },
    );
    const draft = page.locator("textarea:visible");
    assert.equal(await draft.count(), 1, "One active composer is available");
    await draft.fill("Keep this unsent draft");
    await implement.click();
    let submissionTimeout;
    const implementation = await Promise.race([
      planSubmission,
      new Promise((_, reject) => {
        submissionTimeout = setTimeout(
          () => reject(new Error("No plan implementation frame was sent")),
          10000,
        );
      }),
    ]).finally(() => clearTimeout(submissionTimeout));
    assert.equal(implementation.planMode, "off");
    assert.ok(implementation.text.endsWith(proposal.body));
    assert.equal(await draft.inputValue(), "Keep this unsent draft");
    let finished;
    const completionDeadline = Date.now() + 30000;
    while (Date.now() < completionDeadline) {
      finished = await (
        await context.request.get(
          `${url}/api/sessions/${sessionId}/agent-control/history?count=96`,
        )
      ).json();
      if (
        finished.currentTurn.turnId !== initial.currentTurn.turnId &&
        finished.currentTurn.state === "completed"
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(finished.currentTurn.state, "completed");
    assert.notEqual(finished.currentTurn.turnId, initial.currentTurn.turnId);
    assert.equal(finished.quickSettings.planMode, "off");
    assert.ok(
      finished.history.some(
        (item) => item.kind === "user" && item.body.endsWith(proposal.body),
      ),
    );
    assert.equal(await draft.inputValue(), "Keep this unsent draft");
    const implementedScreenshot = path.join(out, "plan-implemented.png");
    await page.screenshot({ path: implementedScreenshot });
    result.screenshots.push(implementedScreenshot);
    result.planReviewVerified = true;
    result.implementationMode = implementation.planMode;
  }
  if (nativeConfig) {
    const sessions = await (
      await context.request.get(`${url}/api/sessions`)
    ).json();
    assert.equal(
      sessions.sessions.find((session) => session.id === sessionId)
        ?.profileHint,
      "acp-config-test",
      "Config submission requires the deterministic fixture",
    );
    await page.waitForFunction(() => {
      const native = document.querySelector(".smart-input-native-config");
      return native && !native.hidden;
    });
    for (const viewport of [
      { width: 1440, height: 1000 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      const native = page.locator(".smart-input-native-config");
      if (!(await native.isVisible()))
        await page
          .locator(".adaptive-footer-status-summary-appServerControl")
          .click();
      if (
        !(await native.locator("details").evaluate((element) => element.open))
      )
        await native.locator("summary").click();
      const agent = native.locator(
        'select[data-native-config-id="native-agent"]',
      );
      await agent.waitFor({ state: "visible" });
      assert.equal(await agent.inputValue(), "");
      assert.equal(
        await agent.locator("optgroup").count(),
        1,
        "Native groups retain their label",
      );
      assert.equal(
        await native
          .locator('[data-native-config-id="future-setting"]')
          .count(),
        0,
        "Unknown types are not rendered as invented controls",
      );
      await agent.scrollIntoViewIfNeeded();
      const box = await agent.boundingBox();
      assert.ok(
        box &&
          box.x >= 0 &&
          box.width <= viewport.width &&
          box.height >= 44 &&
          box.y >= 0 &&
          box.y + box.height <= viewport.height,
        "Native selector fits and has a 44px hit target",
      );
      const panelBox = await native
        .locator(".smart-input-native-config-panel")
        .boundingBox();
      assert.ok(
        panelBox &&
          panelBox.x >= 0 &&
          panelBox.x + panelBox.width <= viewport.width + 1 &&
          panelBox.width >= Math.min(280, viewport.width - 64),
        "The entire native settings panel fits at a usable width",
      );
      const settings = page.locator(
        ".smart-input-appServerControl-settings:visible",
      );
      assert.equal(
        await settings.locator("select").nth(0).inputValue(),
        initial.quickSettings.model,
      );
      assert.equal(
        await settings.locator("select").nth(1).isDisabled(),
        true,
        "Unadvertised effort control is disabled",
      );
      assert.equal(
        await settings
          .locator('[data-app-server-control-field="fast-mode"]')
          .isVisible(),
        false,
        "Unsupported fast mode remains hidden",
      );
      if (viewport.width === 390) {
        const fields = await settings
          .locator(":scope > .smart-input-appServerControl-field:visible")
          .evaluateAll((elements) =>
            elements.map((element) => {
              const box = element.getBoundingClientRect();
              return {
                x: box.x,
                y: box.y,
                right: box.right,
                bottom: box.bottom,
              };
            }),
          );
        for (let i = 0; i < fields.length; i++)
          for (let j = i + 1; j < fields.length; j++)
            assert.ok(
              fields[i].right <= fields[j].x + 1 ||
                fields[j].right <= fields[i].x + 1 ||
                fields[i].bottom <= fields[j].y + 1 ||
                fields[j].bottom <= fields[i].y + 1,
              "Settings fields do not overlap",
            );
      }
      result.measurements.push({ viewport, agent: box });
      const screenshot = path.join(out, `config-${viewport.width}.png`);
      await page.screenshot({ path: screenshot });
      result.screenshots.push(screenshot);
    }
    const native = page.locator(".smart-input-native-config");
    await native
      .locator('select[data-native-config-id="native-agent"]')
      .selectOption("reviewer");
    await native
      .locator('input[data-native-config-id="native-toggle"]')
      .scrollIntoViewIfNeeded();
    await native
      .locator('input[data-native-config-id="native-toggle"]')
      .check();
    const draft = page.locator("textarea:visible");
    await draft.fill("v2-standard configured from browser");
    await page.locator(".smart-input-send-btn:visible").click();
    let timeout;
    const submitted = await Promise.race([
      planSubmission,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("No config turn submitted")),
          10000,
        );
      }),
    ]).finally(() => clearTimeout(timeout));
    assert.deepEqual(submitted.configValues, {
      "native-agent": "reviewer",
      "native-toggle": true,
    });
    let finished;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      finished = await (
        await context.request.get(
          `${url}/api/sessions/${sessionId}/agent-control/history?count=96`,
        )
      ).json();
      if (
        finished.currentTurn.turnId !== initial.currentTurn.turnId &&
        finished.currentTurn.state === "completed"
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.notEqual(finished.currentTurn.turnId, initial.currentTurn.turnId);
    assert.equal(finished.currentTurn.state, "completed");
    assert.equal(
      finished.quickSettings.configOptions.find(
        (option) => option.configId === "native-agent",
      ).currentValue,
      "reviewer",
    );
    assert.equal(
      finished.quickSettings.configOptions.find(
        (option) => option.configId === "native-toggle",
      ).currentValue,
      true,
    );
    const screenshot = path.join(out, "config-applied.png");
    await page.screenshot({ path: screenshot });
    result.screenshots.push(screenshot);
    result.nativeConfigVerified = true;
  }
  if (nativeCommands) {
    const sessions = await (
      await context.request.get(`${url}/api/sessions`)
    ).json();
    assert.equal(
      sessions.sessions.find((session) => session.id === sessionId)
        ?.profileHint,
      "acp-commands-test",
      "Native command execution requires the deterministic fixture",
    );
    const host = wrapper.locator(".agent-native-controls");
    await host.waitFor({ state: "visible" });
    assert.equal(
      await host.locator(".agent-native-name").innerText(),
      "ACP command acceptance",
    );
    for (const viewport of [
      { width: 1440, height: 1000 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      if (!(await host.locator("details").evaluate((element) => element.open)))
        await host.locator("summary").click();
      const form = host.locator("form");
      await form.locator("select").selectOption("compact");
      assert.match(
        await form.locator("p").first().innerText(),
        /Compress conversation history/,
      );
      assert.equal(
        await form.locator("input").getAttribute("placeholder"),
        "optional context about what to preserve",
      );
      const box = await form.boundingBox();
      assert.ok(
        box &&
          box.x >= 0 &&
          box.y >= 0 &&
          box.x + box.width <= viewport.width + 1 &&
          box.y + box.height <= viewport.height,
        "Native command menu fits viewport",
      );
      const buttonBox = await form
        .locator('button[type="submit"]')
        .boundingBox();
      assert.ok(buttonBox && buttonBox.height >= 44);
      result.measurements.push({ viewport, menu: box });
      const screenshot = path.join(out, `commands-${viewport.width}.png`);
      await page.screenshot({ path: screenshot });
      result.screenshots.push(screenshot);
    }
    const draft = page.locator("textarea:visible");
    await draft.fill("Unsent composer remains here");
    const form = host.locator("form");
    await form.locator("input").fill("keep CMD_MARKER_76");
    await form.locator('button[type="submit"]').click();
    let timeout;
    const submitted = await Promise.race([
      planSubmission,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("No native command submitted")),
          10000,
        );
      }),
    ]).finally(() => clearTimeout(timeout));
    assert.equal(submitted.text, "/compact keep CMD_MARKER_76");
    assert.equal(submitted.planMode, "on");
    let finished;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      finished = await (
        await context.request.get(
          `${url}/api/sessions/${sessionId}/agent-control/history?count=96`,
        )
      ).json();
      if (
        finished.currentTurn.turnId !== initial.currentTurn.turnId &&
        finished.currentTurn.state === "completed"
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.notEqual(finished.currentTurn.turnId, initial.currentTurn.turnId);
    assert.equal(finished.currentTurn.state, "completed");
    assert.match(
      finished.streams.assistantText,
      /prompt=\/compact keep CMD_MARKER_76/,
    );
    assert.ok(
      !finished.streams.assistantText.includes("tlbx plan mode is enabled"),
    );
    assert.equal(await draft.inputValue(), "Unsent composer remains here");
    assert.ok(
      !finished.history.some((item) =>
        item.body.includes("commands available:"),
      ),
      "Catalogue does not clutter chat history",
    );
    result.nativeCommandsVerified = true;
  }
  if (nativeUsage) {
    assert.equal(initial.session.usage.contextUsedTokens, 2345);
    assert.equal(initial.session.usage.costCurrency, "EUR");
    const stats = wrapper.locator('[data-agent-field="runtime-stats"]');
    await stats.waitFor({ state: "visible" });
    for (const viewport of [
      { width: 1440, height: 1000 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      const compact = await stats
        .locator(".agent-runtime-stats-compact")
        .innerText();
      assert.ok(
        compact.includes("128k") && compact.includes("0.0123 EUR"),
        "Reported context and native currency render",
      );
      assert.ok(
        !compact.includes("in 0") && !compact.includes("out 0"),
        "Unknown input/output counters are not invented zeros",
      );
      const box = await stats.boundingBox();
      const commandsBox = await wrapper
        .locator(".agent-native-controls")
        .boundingBox();
      assert.ok(
        box &&
          commandsBox &&
          box.x >= 0 &&
          box.x + box.width <= viewport.width + 1 &&
          box.y >= commandsBox.y + commandsBox.height - 1,
        "Usage fits without covering native command controls",
      );
      result.measurements.push({ viewport, stats: box });
      const screenshot = path.join(out, `usage-${viewport.width}.png`);
      await page.screenshot({ path: screenshot });
      result.screenshots.push(screenshot);
    }
    result.nativeUsageVerified = true;
  }
  if (
    !resume &&
    !nativeV2 &&
    !planReview &&
    !nativeConfig &&
    !nativeCommands &&
    !nativeUsage &&
    !initiallyOpen
  ) {
    assert.ok(
      answer &&
        (multi
          ? JSON.parse(initial.streams.assistantText).result.outcome ===
            "accepted"
          : initial.streams.assistantText === "TLBX_GROK_QUESTION_OK_73"),
      "A resumed test must already have the verified answer",
    );
  }
  if (initiallyOpen) {
    const question = wrapper.locator(".agent-request-question").filter({
      hasText: multi ? /^Which color\?$/ : /^Which acceptance color\?$/,
    });
    await question.waitFor({ state: "visible" });
    for (const viewport of [
      { width: 1440, height: 1000 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await question.scrollIntoViewIfNeeded();
      await question.waitFor({ state: "visible" });
      const form = wrapper.locator(".agent-request-form");
      const measurement = await form.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          hidden: document.hidden,
          width: innerWidth,
          height: innerHeight,
          form: {
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
          },
          choices: [...element.querySelectorAll(".agent-request-choice")].map(
            (choice) => {
              const box = choice.getBoundingClientRect();
              return {
                text: choice.innerText,
                width: box.width,
                height: box.height,
              };
            },
          ),
        };
      });
      result.measurements.push(measurement);
      assert.equal(measurement.hidden, false, "Browser document is active");
      assert.ok(
        measurement.form.width > 200 &&
          measurement.form.width <= viewport.width,
        "Question fits viewport",
      );
      assert.equal(measurement.choices.length, 2, "Both native options render");
      if (viewport.width === 390)
        assert.ok(
          measurement.choices.every((choice) => choice.height >= 44),
          "Mobile choices retain 44px hit targets",
        );
      const screenshot = path.join(out, `question-${viewport.width}.png`);
      await page.screenshot({ path: screenshot });
      result.screenshots.push(screenshot);
    }
  }
  if (answer && initiallyOpen) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await wrapper
      .locator(
        '.agent-request-choice:has(.agent-request-choice-input[value="Blue"])',
      )
      .click();
    if (multi) {
      await wrapper
        .locator(".agent-request-question")
        .filter({ hasText: /^Which checks\?$/ })
        .waitFor({ state: "visible" });
      await wrapper
        .locator('.agent-request-button-row button[type="button"]')
        .click();
      await wrapper
        .locator(".agent-request-question")
        .filter({ hasText: /^Which color\?$/ })
        .waitFor({ state: "visible" });
    }
    assert.equal(
      await wrapper
        .locator('.agent-request-choice-input[value="Blue"]')
        .isChecked(),
      true,
    );
    const submit = wrapper.locator('.agent-request-form button[type="submit"]');
    const waitEnabled = () =>
      page.waitForFunction((id) => {
        const button = document.querySelector(
          `.session-wrapper[data-session-id="${id}"] .agent-request-form button[type="submit"]`,
        );
        return button && !button.disabled;
      }, sessionId);
    if (multi) {
      await waitEnabled();
      await submit.click();
      await wrapper
        .locator(".agent-request-question")
        .filter({ hasText: /^Which checks\?$/ })
        .waitFor({ state: "visible" });
      for (const value of ["Tests", "Docs"]) {
        await wrapper
          .locator(
            `.agent-request-choice:has(.agent-request-choice-input[value="${value}"])`,
          )
          .click();
      }
      await waitEnabled();
      await submit.click();
      const textInput = wrapper.locator('.agent-request-input[name="notes"]');
      await textInput.waitFor({ state: "visible" });
      await textInput.focus();
      await textInput.pressSequentially("Typed note");
      assert.equal(
        await textInput.inputValue(),
        "Typed note",
        "Typing retains every character",
      );
      assert.equal(
        await textInput.evaluate(
          (element) => document.activeElement === element,
        ),
        true,
        "Typing retains focus",
      );
    }
    await submit.waitFor({ state: "visible" });
    await waitEnabled();
    assert.equal(await submit.isEnabled(), true, "Answer can be submitted");
    await submit.click();
    result.answerSubmitted = true;
  }
  if (answer) {
    await wrapper
      .locator('[data-agent-field="history"]')
      .waitFor({ state: "visible" });
    const backToBottom = wrapper.locator(
      '[data-agent-field="scroll-to-bottom"]',
    );
    if (await backToBottom.isVisible()) await backToBottom.click();
    if (multi) {
      await wrapper
        .locator(".agent-request-panel-resolved")
        .waitFor({ state: "visible" });
      await page.waitForFunction(
        async (id) => {
          const history = await (
            await fetch(`/api/sessions/${id}/agent-control/history?count=96`)
          ).json();
          return history.currentTurn.state === "completed";
        },
        sessionId,
        { polling: 100 },
      );
      const completed = await (
        await context.request.get(
          `${url}/api/sessions/${sessionId}/agent-control/history?count=96`,
        )
      ).json();
      const native = JSON.parse(completed.streams.assistantText).result;
      assert.deepEqual(native.answers, {
        "Which color?": ["Blue"],
        "Which checks?": ["Tests", "Docs"],
        "Anything else?": ["Other"],
      });
      assert.equal(native.annotations["Anything else?"].notes, "Typed note");
      assert.equal(native.annotations["Which color?"].preview, "#0000ff");
      assert.ok(
        completed.notices.some(
          (notice) => notice.detail === "_x.ai/session/setup",
        ),
        "Unmapped protocol notices remain diagnosable",
      );
      assert.ok(
        !completed.history.some((item) =>
          item.body.includes("ACP notification ignored"),
        ),
        "Unmapped protocol notices stay out of the conversation",
      );
      result.nativeResponseVerified = true;
    } else {
      await wrapper
        .getByText("TLBX_GROK_QUESTION_OK_73", { exact: true })
        .waitFor({ state: "visible", timeout: 60000 });
    }
    const screenshot = path.join(out, "question-answered.png");
    await page.screenshot({ path: screenshot });
    result.screenshots.push(screenshot);
  }
  if (cancel) {
    assert.equal(
      initiallyOpen,
      true,
      "Cancellation starts with a waiting interview",
    );
    const interrupted = await context.request.post(
      `${url}/api/sessions/${sessionId}/agent-control/interrupt`,
      {
        data: { turnId: initial.currentTurn.turnId },
      },
    );
    assert.ok(
      interrupted.ok(),
      `Cancellation accepted: ${await interrupted.text()}`,
    );
    await wrapper
      .locator(".agent-request-eyebrow")
      .filter({ hasText: /^Cancelled$/ })
      .waitFor({ state: "visible" });
    const stopped = await (
      await context.request.get(
        `${url}/api/sessions/${sessionId}/agent-control/history?count=96`,
      )
    ).json();
    assert.equal(stopped.currentTurn.state, "interrupted");
    assert.ok(stopped.requests.every((request) => request.state !== "open"));
    const cancelledRequest = stopped.requests.find(
      (request) => request.kind === "interview",
    );
    assert.equal(cancelledRequest.decision, "cancel");
    assert.equal(
      stopped.history.find(
        (item) => item.requestId === cancelledRequest.requestId,
      ).status,
      "cancelled",
    );
    assert.equal(
      JSON.parse(stopped.streams.assistantText).result.outcome,
      "cancelled",
    );
    assert.equal(
      await wrapper.getByText("Answer submitted", { exact: true }).count(),
      0,
    );
    const screenshot = path.join(out, "question-cancelled.png");
    await page.screenshot({ path: screenshot });
    result.screenshots.push(screenshot);
    result.cancellationVerified = true;
  }
  assert.deepEqual(result.errors, [], "No browser runtime errors");
  result.ok = true;
} catch (error) {
  result.failure = error.stack || String(error);
  if (planReview && page)
    result.planState = await page
      .locator(".agent-plan-implement")
      .evaluateAll((buttons) =>
        buttons.map((button) => ({
          disabled: button.disabled,
          ...button.dataset,
        })),
      )
      .catch(() => []);
  if (page)
    await page
      .screenshot({ path: path.join(out, "failure.png") })
      .catch(() => {});
  process.exitCode = 1;
} finally {
  fs.writeFileSync(
    path.join(out, "result.json"),
    JSON.stringify(result, null, 2),
  );
  await context?.close();
  await browser?.close();
  if (chrome && chrome.exitCode === null) chrome.kill();
  console.log(JSON.stringify(result));
}
