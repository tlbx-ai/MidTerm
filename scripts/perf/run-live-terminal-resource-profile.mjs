import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const execFileAsync = promisify(execFile);
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
const runDir = path.join(artifactRoot, `${stamp}-tlbx-live-terminal-resources`);
const profileDir = path.join(runDir, "chrome-profile");
const cpuProfilePath = path.join(runDir, "cpu-profile.json");
const samplesPath = path.join(runDir, "samples.json");
const summaryPath = path.join(runDir, "summary.json");
const url = process.env.TLBX_PERF_URL || "https://127.0.0.1:2100/";
const sessionCount = Number(process.env.TLBX_PERF_SESSION_COUNT || 6);
const sampleSeconds = Number(process.env.TLBX_PERF_SAMPLE_SECONDS || 40);
const sampleIntervalMs = Number(
  process.env.TLBX_PERF_SAMPLE_INTERVAL_MS || 2000,
);
const warmupSeconds = Number(process.env.TLBX_PERF_WARMUP_SECONDS || 5);
const switchCycles = Number(process.env.TLBX_PERF_SWITCH_CYCLES || 1);
const serverPid = Number(process.env.TLBX_PERF_SERVER_PID || 0);
const collectCpuProfile = process.env.TLBX_PERF_CPU_PROFILE === "1";

if (!Number.isInteger(sessionCount) || sessionCount < 0 || sessionCount > 12) {
  throw new Error(
    `TLBX_PERF_SESSION_COUNT must be between 0 and 12, got ${sessionCount}.`,
  );
}
if (
  !Number.isFinite(warmupSeconds) ||
  warmupSeconds < 0 ||
  warmupSeconds > 60
) {
  throw new Error(
    `TLBX_PERF_WARMUP_SECONDS must be between 0 and 60, got ${warmupSeconds}.`,
  );
}
if (!Number.isInteger(switchCycles) || switchCycles < 0 || switchCycles > 10) {
  throw new Error(
    `TLBX_PERF_SWITCH_CYCLES must be between 0 and 10, got ${switchCycles}.`,
  );
}

await fs.mkdir(profileDir, { recursive: true });

function buildTrafficCommand(index) {
  const payload = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".repeat(6);
  // Windows process-tree snapshots can take several seconds each on a busy
  // host. Keep every shell producing output for the whole measured wall time,
  // not merely for the nominal sample duration.
  const duration = Math.max(sampleSeconds * 8, 60);
  return [
    "$ProgressPreference='SilentlyContinue'",
    `$payload='${payload}'`,
    `$end=(Get-Date).AddSeconds(${duration})`,
    "$i=0",
    `while((Get-Date)-lt $end){$i++; Write-Output (\"perf-${index}-{0:D6} {1}\" -f $i,$payload); Start-Sleep -Milliseconds 20}`,
    `Write-Output 'perf-${index}-done'`,
  ].join("; ");
}

async function browserRequest(page, requestUrl, options = {}) {
  return page.evaluate(
    async ({ requestUrl: requestPath, options: requestOptions }) => {
      const response = await fetch(requestPath, {
        ...requestOptions,
        headers: {
          ...(requestOptions.body
            ? { "Content-Type": "application/json" }
            : {}),
          ...(requestOptions.headers || {}),
        },
      });
      return {
        ok: response.ok,
        status: response.status,
        text: await response.text(),
      };
    },
    { requestUrl, options },
  );
}

async function requestJson(page, requestUrl, options = {}) {
  const response = await browserRequest(page, requestUrl, options);
  if (!response.ok) {
    throw new Error(
      `${options.method || "GET"} ${requestUrl} failed: ${response.status} ${response.text}`,
    );
  }
  if (response.status === 204) return null;
  return response.text ? JSON.parse(response.text) : null;
}

function getSessionId(response) {
  return (
    response?.id ||
    response?.session?.id ||
    response?.sessionId ||
    response?.sessionInfo?.id ||
    null
  );
}

async function getWindowsProcessSnapshot() {
  if (process.platform !== "win32") return null;

  const script = String.raw`
$ErrorActionPreference = 'Stop'
$profileNeedle = $env:TLBX_PROFILE_NEEDLE
$serverPid = [int]$env:TLBX_SERVER_PID_VALUE
$cachedChromeIds = @($env:TLBX_CHROME_IDS -split ',' | Where-Object { $_ } | ForEach-Object { [int]$_ })
$cachedTlbxIds = @($env:TLBX_TLBX_IDS -split ',' | Where-Object { $_ } | ForEach-Object { [int]$_ })
if ($cachedChromeIds.Count -gt 0 -and $cachedTlbxIds.Count -gt 0) {
  $chromeIds = $cachedChromeIds
  $descendantIds = $cachedTlbxIds
} else {
  $cim = @(Get-CimInstance Win32_Process)
  $chromeIds = @($cim | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -like "*$profileNeedle*" } | ForEach-Object { [int]$_.ProcessId })
  $descendantSet = [System.Collections.Generic.HashSet[int]]::new()
  if ($serverPid -gt 0) {
    [void]$descendantSet.Add($serverPid)
    do {
      $before = $descendantSet.Count
      foreach ($proc in $cim) {
        if ($descendantSet.Contains([int]$proc.ParentProcessId)) {
          [void]$descendantSet.Add([int]$proc.ProcessId)
        }
      }
    } while ($descendantSet.Count -ne $before)
  }
  $descendantIds = @($descendantSet)
}
function Measure-Processes([int[]]$ids) {
  $items = @(foreach ($id in $ids) {
    $p = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($p) {
      $processPath = try { $p.Path } catch { $null }
      [pscustomobject]@{
        pid = $p.Id
        name = $p.ProcessName
        path = $processPath
        cpuSeconds = [Math]::Round($p.CPU, 4)
        workingSetBytes = [long]$p.WorkingSet64
        privateBytes = [long]$p.PrivateMemorySize64
      }
    }
  })
  [pscustomobject]@{
    count = $items.Count
    cpuSeconds = [Math]::Round([double](($items | Measure-Object cpuSeconds -Sum).Sum), 4)
    workingSetBytes = [long](($items | Measure-Object workingSetBytes -Sum).Sum)
    privateBytes = [long](($items | Measure-Object privateBytes -Sum).Sum)
    processes = $items
  }
}
[pscustomobject]@{
  chromeIds = $chromeIds
  tlbxIds = $descendantIds
  chrome = Measure-Processes $chromeIds
  tlbx = Measure-Processes @($descendantIds)
} | ConvertTo-Json -Depth 6 -Compress
`;

  const { stdout } = await execFileAsync(
    "pwsh",
    ["-NoProfile", "-Command", script],
    {
      env: {
        ...process.env,
        TLBX_PROFILE_NEEDLE: profileDir,
        TLBX_SERVER_PID_VALUE: String(serverPid),
        TLBX_CHROME_IDS: windowsProcessIds?.chromeIds?.join(",") || "",
        TLBX_TLBX_IDS: windowsProcessIds?.tlbxIds?.join(",") || "",
      },
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  const snapshot = JSON.parse(stdout.trim());
  windowsProcessIds ||= {
    chromeIds: snapshot.chromeIds,
    tlbxIds: snapshot.tlbxIds,
  };
  return snapshot;
}

function metricValue(metrics, name) {
  return metrics.metrics.find((entry) => entry.name === name)?.value ?? null;
}

function bytesToMb(value) {
  return value == null ? null : Math.round((value / 1024 / 1024) * 100) / 100;
}

function byteDeltaToMb(finalValue, baselineValue) {
  if (finalValue == null || baselineValue == null) return null;
  return bytesToMb(finalValue - baselineValue);
}

function summarizePeak(samples, selector) {
  const values = samples
    .map(selector)
    .filter((value) => Number.isFinite(value));
  return values.length ? Math.max(...values) : null;
}

function summarizeCpu(samples, selector) {
  if (samples.length < 2) return null;
  const first = samples[0];
  const last = samples.at(-1);
  const cpuDelta = selector(last) - selector(first);
  const elapsedSeconds = (last.timestampMs - first.timestampMs) / 1000;
  return elapsedSeconds > 0
    ? Math.round((cpuDelta / elapsedSeconds) * 10000) / 100
    : null;
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
  ];
}

function summarizeProcessCpu(samples, predicate) {
  if (samples.length < 2) return [];
  const first = samples[0];
  const last = samples.at(-1);
  const elapsedSeconds = (last.timestampMs - first.timestampMs) / 1000;
  if (elapsedSeconds <= 0) return [];
  const firstByPid = new Map(
    (first.os?.tlbx?.processes || []).map((process) => [process.pid, process]),
  );
  return (last.os?.tlbx?.processes || [])
    .filter(predicate)
    .map((process) => {
      const initial = firstByPid.get(process.pid);
      const cpuDelta = initial ? process.cpuSeconds - initial.cpuSeconds : 0;
      return {
        pid: process.pid,
        name: process.name,
        path: process.path,
        averageCorePercent:
          Math.round((cpuDelta / elapsedSeconds) * 10000) / 100,
      };
    })
    .sort((left, right) => right.averageCorePercent - left.averageCorePercent);
}

function sumProcessMetric(sample, predicate, metric) {
  return (sample?.os?.tlbx?.processes || [])
    .filter(predicate)
    .reduce((sum, process) => sum + (process[metric] || 0), 0);
}

function isTlbxOwnedProcess(process) {
  return process.pid === serverPid || process.name.toLowerCase() === "mthost";
}

function summarizeProcessGroup(samples, predicate) {
  const finalProcesses = (samples.at(-1)?.os?.tlbx?.processes || []).filter(
    predicate,
  );
  return {
    peakWorkingSetMB: bytesToMb(
      summarizePeak(samples, (sample) =>
        sumProcessMetric(sample, predicate, "workingSetBytes"),
      ),
    ),
    peakPrivateMB: bytesToMb(
      summarizePeak(samples, (sample) =>
        sumProcessMetric(sample, predicate, "privateBytes"),
      ),
    ),
    finalWorkingSetMB: bytesToMb(
      sumProcessMetric(samples.at(-1), predicate, "workingSetBytes"),
    ),
    finalPrivateMB: bytesToMb(
      sumProcessMetric(samples.at(-1), predicate, "privateBytes"),
    ),
    averageCorePercent: summarizeCpu(samples, (sample) =>
      sumProcessMetric(sample, predicate, "cpuSeconds"),
    ),
    finalProcessCount: finalProcesses.length,
    finalProcesses,
  };
}

const createdSessionIds = [];
const samples = [];
const switchMeasurements = [];
let backgroundIngestEvidence = null;
let baseline = null;
let windowsProcessIds = null;
let browserContext;
let page;
try {
  browserContext = await chromium.launchPersistentContext(profileDir, {
    channel: "chrome",
    headless: false,
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1000 },
    args: ["--ignore-certificate-errors", "--disable-background-networking"],
  });
  page = browserContext.pages()[0] || (await browserContext.newPage());
  const client = await browserContext.newCDPSession(page);
  await client.send("Performance.enable");
  if (collectCpuProfile) await client.send("Profiler.enable");

  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".terminal-page", { timeout: 30000 });
  await page.waitForTimeout(1500);

  const baselinePerf = await client.send("Performance.getMetrics");
  const baselineDom = await client.send("Memory.getDOMCounters");
  const baselineOs = await getWindowsProcessSnapshot();
  baseline = {
    timestampMs: Date.now(),
    jsHeapUsedBytes: metricValue(baselinePerf, "JSHeapUsedSize"),
    jsHeapTotalBytes: metricValue(baselinePerf, "JSHeapTotalSize"),
    documents: baselineDom.documents,
    nodes: baselineDom.nodes,
    jsEventListeners: baselineDom.jsEventListeners,
    os: baselineOs,
  };
  // The baseline intentionally sees no terminal descendants. Discover the full
  // process tree again after creating the traffic sessions, then keep that set
  // stable for the sampled CPU deltas.
  windowsProcessIds = null;

  for (let i = 1; i <= sessionCount; i += 1) {
    const created = await requestJson(page, "/api/sessions", {
      method: "POST",
      body: JSON.stringify({ cols: 128, rows: 32, shell: "Pwsh" }),
    });
    const sessionId = getSessionId(created);
    if (!sessionId)
      throw new Error(`Create session had no id: ${JSON.stringify(created)}`);
    createdSessionIds.push(sessionId);
    await requestJson(
      page,
      `/api/sessions/${encodeURIComponent(sessionId)}/name`,
      {
        method: "PUT",
        body: JSON.stringify({ name: `perf-live-${i}` }),
      },
    );
  }

  await page.waitForFunction(
    (ids) =>
      ids.every((id) =>
        document.querySelector(
          `.session-item[data-session-id="${CSS.escape(id)}"]`,
        ),
      ),
    createdSessionIds,
    { timeout: 30000 },
  );

  await page.waitForFunction(
    async (ids) => {
      const response = await fetch("/api/sessions");
      if (!response.ok) return false;
      const payload = await response.json();
      const byId = new Map(
        payload.sessions.map((session) => [session.id, session]),
      );
      return ids.every((id) => Boolean(byId.get(id)?.supervisor?.lastOutputAt));
    },
    createdSessionIds,
    { timeout: 30000 },
  );

  for (const sessionId of createdSessionIds) {
    await page.locator(`.session-item[data-session-id="${sessionId}"]`).click();
    await page.waitForFunction(
      (id) => window.mmDebug?.activeId === id,
      sessionId,
      { timeout: 10000 },
    );
  }

  const mountedBeforeTraffic = await page.evaluate(() => ({
    xterms: document.querySelectorAll(".xterm").length,
    sessionItems: document.querySelectorAll(".session-item[data-session-id]")
      .length,
    sessionTabs: document.querySelectorAll(
      ".session-tab[data-session-id], .tab[data-session-id]",
    ).length,
  }));

  // Give the active-session hint a short turn after all PTYs have proven they
  // can produce output. Readiness itself is established above from live state.
  await page.waitForTimeout(250);

  await page.evaluate((ids) => {
    const renderCounts = Object.fromEntries(ids.map((id) => [id, 0]));
    const parseCounts = Object.fromEntries(ids.map((id) => [id, 0]));
    const disposables = [];
    for (const id of ids) {
      const state = window.mmDebug?.terminals.get(id);
      if (!state) continue;
      disposables.push(
        state.terminal.onRender(() => {
          renderCounts[id] = (renderCounts[id] ?? 0) + 1;
        }),
        state.terminal.onWriteParsed(() => {
          parseCounts[id] = (parseCounts[id] ?? 0) + 1;
        }),
      );
    }
    window.__tlbxBackgroundRenderProbe = {
      renderCounts,
      parseCounts,
      disposables,
    };
  }, createdSessionIds);
  await page.waitForTimeout(100);
  await page.evaluate((ids) => {
    const probe = window.__tlbxBackgroundRenderProbe;
    if (probe) {
      for (const id of ids) {
        probe.renderCounts[id] = 0;
        probe.parseCounts[id] = 0;
      }
    }
  }, createdSessionIds);

  const sessionsBeforeTraffic = await requestJson(page, "/api/sessions");
  const lastOutputBeforeTraffic = Object.fromEntries(
    sessionsBeforeTraffic.sessions
      .filter((session) => createdSessionIds.includes(session.id))
      .map((session) => [session.id, session.supervisor?.lastOutputAt ?? null]),
  );

  for (let index = 0; index < createdSessionIds.length; index += 1) {
    const command = buildTrafficCommand(index + 1);
    if (index === createdSessionIds.length - 1) {
      // Exercise the real visible-terminal path. A terminal input Mux frame
      // atomically marks this browser client's session active before writing,
      // whereas the HTTP automation endpoint intentionally has no per-browser
      // active-session context.
      await page
        .locator(".terminal-container:not(.hidden) .xterm-helper-textarea")
        .focus();
      await page.keyboard.press("a");
      await page.keyboard.press("Backspace");
      await page.waitForTimeout(100);
    }

    await requestJson(
      page,
      `/api/sessions/${encodeURIComponent(createdSessionIds[index])}/input/text`,
      {
        method: "POST",
        body: JSON.stringify({ text: command, appendNewline: true }),
      },
    );
  }

  if (createdSessionIds.length > 0) {
    await page.waitForFunction(
      async ({ ids, previousOutput }) => {
        const response = await fetch("/api/sessions");
        if (!response.ok) return false;
        const payload = await response.json();
        const byId = new Map(
          payload.sessions.map((session) => [session.id, session]),
        );
        return ids.every((id) => {
          const lastOutputAt = byId.get(id)?.supervisor?.lastOutputAt ?? null;
          return lastOutputAt !== null && lastOutputAt !== previousOutput[id];
        });
      },
      { ids: createdSessionIds, previousOutput: lastOutputBeforeTraffic },
      { timeout: 15000 },
    );

    // Hidden xterms keep their parser state current from four batched mux
    // deliveries per second. Their renderer must remain completely idle.
    await page.waitForTimeout(1500);
    backgroundIngestEvidence = await page.evaluate(
      (ids) => {
        const probe = window.__tlbxBackgroundRenderProbe;
        const terminals = ids.map((id) => {
          const state = window.mmDebug?.terminals.get(id);
          const hidden = state?.container.classList.contains('hidden') ?? true;
          return {
            sessionId: id,
            hidden,
            renderEvents: probe?.renderCounts[id] ?? null,
            parseEvents: probe?.parseCounts[id] ?? null,
          };
        });
        for (const disposable of probe?.disposables ?? []) disposable.dispose();
        delete window.__tlbxBackgroundRenderProbe;
        const hiddenTerminals = terminals.filter((terminal) => terminal.hidden);
        return {
          terminals,
          allHiddenParsersAdvanced: hiddenTerminals.every(
            (terminal) => (terminal.parseEvents ?? 0) > 0,
          ),
          hiddenRenderEvents: hiddenTerminals.reduce(
            (sum, terminal) => sum + (terminal.renderEvents ?? 0),
            0,
          ),
        };
      },
      createdSessionIds,
    );
    if (!backgroundIngestEvidence.allHiddenParsersAdvanced) {
      throw new Error(
        `At least one hidden terminal stopped parsing output: ${JSON.stringify(backgroundIngestEvidence.terminals)}`,
      );
    }
    if (backgroundIngestEvidence.hiddenRenderEvents !== 0) {
      throw new Error(
        `Hidden terminals emitted ${backgroundIngestEvidence.hiddenRenderEvents} renderer events.`,
      );
    }

    const expectsWebgl = await page.evaluate(
      () => window.mmDebug?.settings?.useWebGL !== false,
    );
    for (let cycle = 0; cycle < switchCycles; cycle += 1) {
      for (const sessionId of createdSessionIds) {
        const measurement = await page.evaluate(
          async ({ id, webglRequired }) => {
            const item = document.querySelector(
              `.session-item[data-session-id="${CSS.escape(id)}"]`,
            );
            if (!(item instanceof HTMLElement)) {
              throw new Error(`Session item ${id} is missing.`);
            }

            const startedAt = performance.now();
            const deadline = startedAt + 15000;
            const nextFrame = () =>
              new Promise((resolve) => requestAnimationFrame(resolve));
            item.click();

            let state = window.mmDebug?.terminals.get(id);
            while (
              !(
                window.mmDebug?.activeId === id &&
                state?.opened &&
                !state.container.classList.contains("hidden")
              )
            ) {
              if (performance.now() >= deadline) {
                throw new Error(`Session ${id} did not become visible.`);
              }
              await nextFrame();
              state = window.mmDebug?.terminals.get(id);
            }
            const visibleMs = performance.now() - startedAt;

            while (
              !(
                window.mmDebug?.activeId === id &&
                (!webglRequired || state?.hasWebgl === true) &&
                (state?.terminal.buffer.active.baseY ?? 0) > 0
              )
            ) {
              if (performance.now() >= deadline) {
                throw new Error(`Session ${id} did not become activation-ready.`);
              }
              await nextFrame();
              state = window.mmDebug?.terminals.get(id);
            }

            return {
              sessionId: id,
              visibleMs: Math.round(visibleMs * 100) / 100,
              activationReadyMs:
                Math.round((performance.now() - startedAt) * 100) / 100,
              postVisibleGapMs:
                Math.round((performance.now() - startedAt - visibleMs) * 100) / 100,
            };
          },
          { id: sessionId, webglRequired: expectsWebgl },
        );
        switchMeasurements.push(measurement);
      }
    }
  }

  await page.waitForTimeout(warmupSeconds * 1000);
  if (collectCpuProfile) await client.send("Profiler.start");
  const startedAt = Date.now();
  const sampleCount = Math.ceil((sampleSeconds * 1000) / sampleIntervalMs) + 1;
  for (let index = 0; index < sampleCount; index += 1) {
    const perf = await client.send("Performance.getMetrics");
    const dom = await client.send("Memory.getDOMCounters");
    const os = await getWindowsProcessSnapshot();
    const browser = await page.evaluate(() => ({
      xterms: document.querySelectorAll(".xterm").length,
      canvases: document.querySelectorAll("canvas").length,
      sessionItems: document.querySelectorAll(".session-item[data-session-id]")
        .length,
      activeId: window.mmDebug?.activeId ?? null,
      terminalSummary: window.mmDebug?.perf.snapshot().terminalSummary ?? null,
    }));
    samples.push({
      timestampMs: Date.now(),
      elapsedMs: Date.now() - startedAt,
      jsHeapUsedBytes: metricValue(perf, "JSHeapUsedSize"),
      jsHeapTotalBytes: metricValue(perf, "JSHeapTotalSize"),
      documents: dom.documents,
      nodes: dom.nodes,
      jsEventListeners: dom.jsEventListeners,
      browser,
      os,
    });
    if (index + 1 < sampleCount) await page.waitForTimeout(sampleIntervalMs);
  }

  if (collectCpuProfile) {
    const cpuProfile = await client.send("Profiler.stop");
    await fs.writeFile(
      cpuProfilePath,
      `${JSON.stringify(cpuProfile.profile)}\n`,
      "utf8",
    );
  }
  await fs.writeFile(
    samplesPath,
    `${JSON.stringify(samples, null, 2)}\n`,
    "utf8",
  );

  const final = samples.at(-1);
  const tlbxOwned = summarizeProcessGroup(samples, isTlbxOwnedProcess);
  tlbxOwned.incrementalWorkingSetMB = byteDeltaToMb(
    sumProcessMetric(final, isTlbxOwnedProcess, "workingSetBytes"),
    sumProcessMetric(baseline, isTlbxOwnedProcess, "workingSetBytes"),
  );
  tlbxOwned.incrementalPrivateMB = byteDeltaToMb(
    sumProcessMetric(final, isTlbxOwnedProcess, "privateBytes"),
    sumProcessMetric(baseline, isTlbxOwnedProcess, "privateBytes"),
  );
  const summary = {
    ok: true,
    url,
    runDir,
    summaryPath,
    samplesPath,
    cpuProfilePath: collectCpuProfile ? cpuProfilePath : null,
    sessionCount,
    sampleSeconds,
    warmupSeconds,
    switchCycles,
    switching: {
      count: switchMeasurements.length,
      visibleAverageMs:
        switchMeasurements.length > 0
          ? Math.round(
              switchMeasurements.reduce(
                (sum, value) => sum + value.visibleMs,
                0,
              ) / switchMeasurements.length,
            )
          : null,
      visibleP95Ms: percentile(
        switchMeasurements.map((measurement) => measurement.visibleMs),
        0.95,
      ),
      activationReadyAverageMs:
        switchMeasurements.length > 0
          ? Math.round(
              switchMeasurements.reduce(
                (sum, value) => sum + value.activationReadyMs,
                0,
              ) / switchMeasurements.length,
            )
          : null,
      activationReadyP95Ms: percentile(
        switchMeasurements.map((measurement) => measurement.activationReadyMs),
        0.95,
      ),
      postVisibleGapP95Ms: percentile(
        switchMeasurements.map((measurement) => measurement.postVisibleGapMs),
        0.95,
      ),
      samples: switchMeasurements,
    },
    baseline: {
      jsHeapUsedMB: bytesToMb(baseline?.jsHeapUsedBytes),
      chromeWorkingSetMB: bytesToMb(baseline?.os?.chrome?.workingSetBytes),
      chromePrivateMB: bytesToMb(baseline?.os?.chrome?.privateBytes),
      tlbxOwnedWorkingSetMB: bytesToMb(
        sumProcessMetric(baseline, isTlbxOwnedProcess, "workingSetBytes"),
      ),
      tlbxOwnedPrivateMB: bytesToMb(
        sumProcessMetric(baseline, isTlbxOwnedProcess, "privateBytes"),
      ),
    },
    mountedBeforeTraffic,
    backgroundIngestEvidence,
    sampleCount: samples.length,
    browser: {
      peakJsHeapUsedMB: bytesToMb(
        summarizePeak(samples, (sample) => sample.jsHeapUsedBytes),
      ),
      peakJsHeapTotalMB: bytesToMb(
        summarizePeak(samples, (sample) => sample.jsHeapTotalBytes),
      ),
      finalJsHeapUsedMB: bytesToMb(final?.jsHeapUsedBytes),
      finalDomNodes: final?.nodes ?? null,
      finalEventListeners: final?.jsEventListeners ?? null,
      peakChromeWorkingSetMB: bytesToMb(
        summarizePeak(samples, (sample) => sample.os?.chrome?.workingSetBytes),
      ),
      peakChromePrivateMB: bytesToMb(
        summarizePeak(samples, (sample) => sample.os?.chrome?.privateBytes),
      ),
      finalChromeWorkingSetMB: bytesToMb(final?.os?.chrome?.workingSetBytes),
      finalChromePrivateMB: bytesToMb(final?.os?.chrome?.privateBytes),
      incrementalJsHeapUsedMB: byteDeltaToMb(
        final?.jsHeapUsedBytes,
        baseline?.jsHeapUsedBytes,
      ),
      incrementalChromeWorkingSetMB: byteDeltaToMb(
        final?.os?.chrome?.workingSetBytes,
        baseline?.os?.chrome?.workingSetBytes,
      ),
      incrementalChromePrivateMB: byteDeltaToMb(
        final?.os?.chrome?.privateBytes,
        baseline?.os?.chrome?.privateBytes,
      ),
      chromeAverageCorePercent: summarizeCpu(
        samples,
        (sample) => sample.os?.chrome?.cpuSeconds ?? 0,
      ),
      finalTerminalSummary: final?.browser?.terminalSummary ?? null,
    },
    tlbx: {
      peakWorkingSetMB: bytesToMb(
        summarizePeak(samples, (sample) => sample.os?.tlbx?.workingSetBytes),
      ),
      peakPrivateMB: bytesToMb(
        summarizePeak(samples, (sample) => sample.os?.tlbx?.privateBytes),
      ),
      averageCorePercent: summarizeCpu(
        samples,
        (sample) => sample.os?.tlbx?.cpuSeconds ?? 0,
      ),
      finalProcessCount: final?.os?.tlbx?.count ?? null,
      finalProcesses: final?.os?.tlbx?.processes ?? [],
      owned: tlbxOwned,
      ownedCpuByProcess: summarizeProcessCpu(samples, isTlbxOwnedProcess),
      shellAndConsole: summarizeProcessGroup(
        samples,
        (process) => !isTlbxOwnedProcess(process),
      ),
    },
  };
  await fs.writeFile(
    summaryPath,
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
  );
  console.log(JSON.stringify(summary, null, 2));
} finally {
  if (page) {
    await page
      .evaluate(() => {
        const probe = window.__tlbxBackgroundRenderProbe;
        for (const disposable of probe?.disposables ?? []) disposable.dispose();
        delete window.__tlbxBackgroundRenderProbe;
      })
      .catch(() => {});
    for (const sessionId of createdSessionIds) {
      try {
        await browserRequest(
          page,
          `/api/sessions/${encodeURIComponent(sessionId)}`,
          { method: "DELETE" },
        );
      } catch {
        // Best-effort cleanup after a failed profile.
      }
    }
  }
  if (browserContext) await browserContext.close();
}
