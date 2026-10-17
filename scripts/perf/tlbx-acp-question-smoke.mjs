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
  assert.ok(initialResponse.ok(), "Canonical question state is readable");
  const initial = await initialResponse.json();
  const initiallyOpen = initial.requests.some(
    (request) => request.kind === "interview" && request.state === "open",
  );
  result.initiallyOpen = initiallyOpen;
  if (!initiallyOpen) {
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
