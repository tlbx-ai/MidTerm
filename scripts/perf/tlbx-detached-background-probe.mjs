/**
 * Profiles tlbx background/reactivation behavior in a standalone Google Chrome
 * window without Playwright's background-throttling overrides.
 *
 * The probe creates and removes a temporary terminal session, fully disconnects
 * CDP while tlbx is on a genuine background tab or Chrome is minimized, samples
 * the complete Chrome process tree, and writes summary.json plus optional Chrome
 * trace artifacts.
 *
 * Key environment variables:
 *   TLBX_PERF_URL=https://localhost:2000/
 *   TLBX_COOKIE_HEADER="mm-session=..."
 *   TLBX_PROBE_BACKGROUND_MS=300000
 *   TLBX_PROBE_WARMUP_MS=30000
 *   TLBX_PROBE_BACKGROUND_MODE=tab|minimize
 *   TLBX_PROBE_PROFILE_DIR=C:\path\to\dedicated-profile
 *   TLBX_PROBE_TRACE=true|false
 */
import fs from "node:fs/promises";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const targetUrl = process.env.TLBX_PERF_URL || "https://localhost:2000/";
const cookieHeader = process.env.TLBX_COOKIE_HEADER || "";
const backgroundMs = Number(process.env.TLBX_PROBE_BACKGROUND_MS || 300_000);
const warmupMs = Number(process.env.TLBX_PROBE_WARMUP_MS || 0);
const processSampleMs = Number(
  process.env.TLBX_PROBE_PROCESS_SAMPLE_MS || 1000,
);
const backgroundCommand = process.env.TLBX_PROBE_BACKGROUND_COMMAND || "";
const expectedTerminalText = process.env.TLBX_PROBE_EXPECT_TERMINAL_TEXT || "";
const traceEnabled = process.env.TLBX_PROBE_TRACE !== "false";
const backgroundMode = process.env.TLBX_PROBE_BACKGROUND_MODE || "tab";
if (!["tab", "minimize"].includes(backgroundMode)) {
  throw new Error(
    `TLBX_PROBE_BACKGROUND_MODE must be "tab" or "minimize", got ${backgroundMode}.`,
  );
}
const chromeExecutable =
  process.env.TLBX_PROBE_CHROME_PATH ||
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const artifactRoot =
  process.env.TLBX_PERF_ARTIFACT_ROOT ||
  path.join(
    process.env.USERPROFILE || process.env.HOME || process.cwd(),
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
  `${stamp}-tlbx-detached-background-profile`,
);
const profileDir = process.env.TLBX_PROBE_PROFILE_DIR
  ? path.resolve(process.env.TLBX_PROBE_PROFILE_DIR)
  : path.join(runDir, "chrome-profile");
const summaryPath = path.join(runDir, "summary.json");
const processSamplesPath = path.join(runDir, "chrome-process-samples.json");
const tracePath = path.join(runDir, "chrome-trace.json");
const screenshotPath = path.join(runDir, "reactivated.png");
const chromeStdoutPath = path.join(runDir, "chrome.stdout.log");
const chromeStderrPath = path.join(runDir, "chrome.stderr.log");
const bootUrl =
  "data:text/html,<title>TLBX_DETACHED_PROBE_BOOT</title><main>tlbx detached probe</main>";

await Promise.all([
  fs.mkdir(runDir, { recursive: true }),
  fs.mkdir(profileDir, { recursive: true }),
]);
await fs.rm(path.join(profileDir, "DevToolsActivePort"), { force: true });

class CdpClient {
  constructor(webSocketUrl) {
    this.socket = new WebSocket(webSocketUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener(
        "error",
        () => reject(new Error(`CDP connection failed: ${webSocketUrl}`)),
        { once: true },
      );
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(
          new Error(
            `${pending.method}: ${message.error.message || "CDP error"}`,
          ),
        );
      } else {
        pending.resolve(message.result);
      }
    });
    this.socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(
          new Error(`CDP disconnected while waiting for ${pending.method}`),
        );
      }
      this.pending.clear();
    });
  }

  async send(method, params = {}, timeoutMs = 10_000) {
    await this.ready;
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timeout });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async close() {
    if (this.socket.readyState >= WebSocket.CLOSING) return;
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 1000);
      this.socket.addEventListener(
        "close",
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true },
      );
      this.socket.close();
    });
  }
}

function parseCookies(rawHeader) {
  const parsedUrl = new URL(targetUrl);
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
        domain: parsedUrl.hostname,
        path: "/",
        secure: parsedUrl.protocol === "https:",
        sameSite: "None",
      };
    })
    .filter(Boolean);
}

async function waitForDevToolsPort(timeoutMs = 15_000) {
  const portFile = path.join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const [portLine] = (await fs.readFile(portFile, "utf8")).split(/\r?\n/);
      const port = Number(portLine);
      if (Number.isInteger(port) && port > 0) return port;
    } catch {
      // Chrome has not published its debugging endpoint yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Chrome did not publish its CDP port within ${timeoutMs}ms.`);
}

async function launchChrome() {
  const stdoutHandle = await fs.open(chromeStdoutPath, "w");
  const stderrHandle = await fs.open(chromeStderrPath, "w");
  const traceDurationSeconds = Math.ceil(backgroundMs / 1000) + 90;
  const args = [
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "--ignore-certificate-errors",
    "--enable-precise-memory-info",
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
  ];
  if (traceEnabled) {
    args.push(
      `--trace-startup=${[
        "blink",
        "blink.user_timing",
        "devtools.timeline",
        "renderer.scheduler",
        "sequence_manager",
        "toplevel",
        "v8",
      ].join(",")}`,
      `--trace-startup-duration=${traceDurationSeconds}`,
      "--trace-startup-format=json",
      "--trace-startup-record-mode=record-continuously",
      `--trace-startup-file=${tracePath}`,
    );
  }
  args.push(bootUrl);
  let child;
  try {
    child = spawn(chromeExecutable, args, {
      detached: false,
      stdio: ["ignore", stdoutHandle.fd, stderrHandle.fd],
      windowsHide: false,
    });
  } finally {
    await Promise.all([stdoutHandle.close(), stderrHandle.close()]);
  }
  const port = await waitForDevToolsPort();
  return { child, port, args };
}

async function listTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) {
    throw new Error(`Chrome target list failed: ${response.status}`);
  }
  return response.json();
}

async function switchChromeTarget(
  port,
  action,
  originalTargetId,
  closeTargetId = null,
) {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`);
  if (!response.ok) {
    throw new Error(`Chrome version target failed: ${response.status}`);
  }
  const version = await response.json();
  if (!version.webSocketDebuggerUrl) {
    throw new Error("Chrome did not expose a browser CDP endpoint.");
  }

  const browserClient = new CdpClient(version.webSocketDebuggerUrl);
  await browserClient.ready;
  const requestedAt = new Date().toISOString();
  let targetId = originalTargetId;
  let closedTargetId = null;
  try {
    if (action === "background") {
      const created = await browserClient.send("Target.createTarget", {
        url: "about:blank",
        background: false,
      });
      targetId = created.targetId;
    }
    await browserClient.send("Target.activateTarget", { targetId });
    if (closeTargetId && closeTargetId !== targetId) {
      const closed = await browserClient.send("Target.closeTarget", {
        targetId: closeTargetId,
      });
      if (closed.success !== false) closedTargetId = closeTargetId;
    }
  } finally {
    await browserClient.close();
  }
  return {
    action,
    requestedAt,
    detachedAt: new Date().toISOString(),
    targetId,
    closedTargetId,
  };
}

async function closeChromeGracefully(port, chromeProcess) {
  if (!port || !chromeProcess || chromeProcess.exitCode !== null) return true;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`);
    if (!response.ok) return false;
    const version = await response.json();
    if (!version.webSocketDebuggerUrl) return false;
    const browserClient = new CdpClient(version.webSocketDebuggerUrl);
    await browserClient.ready;
    await browserClient.send("Browser.close", {}, 5000).catch(() => {});
    await browserClient.close().catch(() => {});
    const deadline = Date.now() + 10_000;
    while (chromeProcess.exitCode === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return chromeProcess.exitCode !== null;
  } catch {
    return false;
  }
}

async function findPageTarget(port, targetId = null, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await listTargets(port);
    const target = targets.find(
      (candidate) =>
        candidate.type === "page" &&
        (targetId ? candidate.id === targetId : true),
    );
    if (target?.webSocketDebuggerUrl) return target;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    targetId
      ? `Chrome page target ${targetId} was not available.`
      : "Chrome did not expose a page target.",
  );
}

async function readPageVisibility(port, targetId) {
  const target = await findPageTarget(port, targetId, 5000);
  const pageClient = new CdpClient(target.webSocketDebuggerUrl);
  await pageClient.ready;
  const queriedAt = new Date().toISOString();
  let evidence;
  try {
    const result = await pageClient.send("Runtime.evaluate", {
      expression: `({
        visibilityState: document.visibilityState,
        hidden: document.hidden,
        focus: document.hasFocus(),
      })`,
      returnByValue: true,
    });
    evidence = result.result.value;
  } finally {
    await pageClient.close();
  }
  return {
    queriedAt,
    detachedAt: new Date().toISOString(),
    ...evidence,
  };
}

async function evaluate(client, expression, options = {}) {
  const result = await client.send(
    "Runtime.evaluate",
    {
      expression,
      awaitPromise: options.awaitPromise ?? true,
      returnByValue: true,
      userGesture: options.userGesture ?? false,
    },
    options.timeoutMs ?? 10_000,
  );
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        "Runtime.evaluate failed",
    );
  }
  return result.result.value;
}

async function waitForExpression(
  client,
  expression,
  timeoutMs = 30_000,
  intervalMs = 100,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(client, expression)) return;
    } catch {
      // The renderer may be navigating between polling attempts.
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Expression did not become true: ${expression}`);
}

async function api(pageClient, pathname, init = {}) {
  const response = await evaluate(
    pageClient,
    `(async () => {
      const response = await fetch(${JSON.stringify(pathname)}, ${JSON.stringify({
        ...init,
        headers: {
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
      })});
      return {
        ok: response.ok,
        status: response.status,
        contentType: response.headers.get("content-type") || "",
        text: await response.text(),
      };
    })()`,
  );
  if (!response.ok) {
    throw new Error(
      `${init.method || "GET"} ${pathname} failed: ${response.status}`,
    );
  }
  return response.contentType.includes("application/json") && response.text
    ? JSON.parse(response.text)
    : response.text;
}

const windowStateScript = String.raw`
$needle = $env:TLBX_CHROME_PROFILE_DIR
$action = $env:TLBX_CHROME_WINDOW_ACTION
$holdMs = [int]$env:TLBX_CHROME_WINDOW_HOLD_MS
$root = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object {
    $_.Name -eq 'chrome.exe' -and
    $_.CommandLine -like "*$needle*" -and
    $_.CommandLine -notmatch '--type='
  } |
  Sort-Object CreationDate |
  Select-Object -First 1
if ($null -eq $root) {
  throw 'Standalone Chrome process was not found.'
}
$runtime = Get-Process -Id $root.ProcessId -ErrorAction Stop
$handle = $runtime.MainWindowHandle
if ($handle -eq 0) {
  throw "Standalone Chrome PID $($root.ProcessId) has no main window."
}
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class TLBXDetachedProbeWindow {
  [DllImport("user32.dll")]
  public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern void keybd_event(
    byte bVk,
    byte bScan,
    uint dwFlags,
    UIntPtr dwExtraInfo
  );
  [DllImport("user32.dll")]
  public static extern bool SetWindowPos(
    IntPtr hWnd,
    IntPtr hWndInsertAfter,
    int X,
    int Y,
    int cx,
    int cy,
    uint uFlags
  );
}
'@
$beforeIconic = [TLBXDetachedProbeWindow]::IsIconic($handle)
$foregroundAccepted = $false
$topmostAccepted = $false
$appActivated = $false
$minimizeRequestedAt = $null
if ($action -eq 'minimize') {
  $accepted = [TLBXDetachedProbeWindow]::ShowWindowAsync($handle, 6)
} elseif ($action -eq 'restore' -or $action -eq 'restore-then-minimize') {
  $accepted = [TLBXDetachedProbeWindow]::ShowWindowAsync($handle, 9)
  Start-Sleep -Milliseconds 250
  $topmostAccepted = [TLBXDetachedProbeWindow]::SetWindowPos(
    $handle,
    [IntPtr](-1),
    0,
    0,
    0,
    0,
    0x0043
  )
  [TLBXDetachedProbeWindow]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
  [TLBXDetachedProbeWindow]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  [void][TLBXDetachedProbeWindow]::BringWindowToTop($handle)
  $foregroundAccepted = [TLBXDetachedProbeWindow]::SetForegroundWindow($handle)
  $shell = New-Object -ComObject WScript.Shell
  $appActivated = $shell.AppActivate([int]$root.ProcessId)
  if ($holdMs -gt 0) {
    $holdDeadline = [DateTimeOffset]::UtcNow.AddMilliseconds($holdMs)
    while ([DateTimeOffset]::UtcNow -lt $holdDeadline) {
      [TLBXDetachedProbeWindow]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
      [TLBXDetachedProbeWindow]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
      [void][TLBXDetachedProbeWindow]::BringWindowToTop($handle)
      $foregroundAccepted = (
        [TLBXDetachedProbeWindow]::SetForegroundWindow($handle) -or
        $foregroundAccepted
      )
      $appActivated = (
        $shell.AppActivate([int]$root.ProcessId) -or
        $appActivated
      )
      [void][TLBXDetachedProbeWindow]::SetWindowPos(
        $handle,
        [IntPtr](-1),
        0,
        0,
        0,
        0,
        0x0043
      )
      Start-Sleep -Milliseconds 50
    }
  }
  if ($action -eq 'restore-then-minimize') {
    $minimizeRequestedAt = [DateTimeOffset]::UtcNow.ToString('o')
    $accepted = [TLBXDetachedProbeWindow]::ShowWindowAsync($handle, 6)
  }
} else {
  throw "Unsupported Chrome window action: $action"
}
Start-Sleep -Milliseconds 750
$afterIconic = [TLBXDetachedProbeWindow]::IsIconic($handle)
[pscustomobject]@{
  action = $action
  accepted = [bool]$accepted
  pid = [int]$root.ProcessId
  hwnd = [long]$handle
  beforeIconic = [bool]$beforeIconic
  afterIconic = [bool]$afterIconic
  foregroundAccepted = [bool]$foregroundAccepted
  topmostAccepted = [bool]$topmostAccepted
  appActivated = [bool]$appActivated
  minimizeRequestedAt = $minimizeRequestedAt
  title = [string](Get-Process -Id $root.ProcessId).MainWindowTitle
  changedAt = [DateTimeOffset]::UtcNow.ToString('o')
} | ConvertTo-Json -Compress
`;

async function setChromeWindowState(action, holdMs = 0) {
  const { stdout } = await execFileAsync(
    "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    ["-NoProfile", "-Command", windowStateScript],
    {
      env: {
        ...process.env,
        TLBX_CHROME_PROFILE_DIR: profileDir,
        TLBX_CHROME_WINDOW_ACTION: action,
        TLBX_CHROME_WINDOW_HOLD_MS: String(holdMs),
      },
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    },
  );
  return JSON.parse(stdout.trim());
}

const processProbeScript = String.raw`
$needle = $env:TLBX_CHROME_PROFILE_DIR
$all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
$root = $all |
  Where-Object {
    $_.Name -eq 'chrome.exe' -and
    $_.CommandLine -like "*$needle*" -and
    $_.CommandLine -notmatch '--type='
  } |
  Sort-Object CreationDate |
  Select-Object -First 1
if ($null -eq $root) {
  [pscustomobject]@{
    capturedAt = [DateTimeOffset]::UtcNow.ToString('o')
    rootPid = $null
    processes = @()
  } | ConvertTo-Json -Compress -Depth 4
  exit 0
}
$ids = [System.Collections.Generic.HashSet[int]]::new()
[void]$ids.Add([int]$root.ProcessId)
$changed = $true
while ($changed) {
  $changed = $false
  foreach ($process in $all) {
    if (
      $ids.Contains([int]$process.ParentProcessId) -and
      -not $ids.Contains([int]$process.ProcessId)
    ) {
      [void]$ids.Add([int]$process.ProcessId)
      $changed = $true
    }
  }
}
$rows = @(
  foreach ($process in $all) {
    if (-not $ids.Contains([int]$process.ProcessId)) { continue }
    $runtime = Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue
    if ($null -eq $runtime) { continue }
    $kind = 'browser'
    if ($process.ProcessId -ne $root.ProcessId) {
      $match = [regex]::Match([string]$process.CommandLine, '--type=([^\s"]+)')
      $kind = if ($match.Success) { $match.Groups[1].Value } else { 'child' }
      if ($kind -eq 'utility') {
        $utilityMatch = [regex]::Match(
          [string]$process.CommandLine,
          '--utility-sub-type=([^\s"]+)'
        )
        if ($utilityMatch.Success) {
          $kind = "utility:$($utilityMatch.Groups[1].Value)"
        }
      }
    }
    [pscustomobject]@{
      pid = [int]$process.ProcessId
      parentPid = [int]$process.ParentProcessId
      kind = $kind
      cpuSeconds = if ($null -eq $runtime.CPU) { 0 } else { [double]$runtime.CPU }
      privateMB = [math]::Round($runtime.PrivateMemorySize64 / 1MB, 3)
      workingSetMB = [math]::Round($runtime.WorkingSet64 / 1MB, 3)
      handles = [int]$runtime.HandleCount
      threads = [int]$runtime.Threads.Count
    }
  }
)
[pscustomobject]@{
  capturedAt = [DateTimeOffset]::UtcNow.ToString('o')
  rootPid = [int]$root.ProcessId
  processes = $rows
} | ConvertTo-Json -Compress -Depth 4
`;

async function sampleChromeProcesses() {
  const { stdout } = await execFileAsync(
    "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    ["-NoProfile", "-Command", processProbeScript],
    {
      env: {
        ...process.env,
        TLBX_CHROME_PROFILE_DIR: profileDir,
      },
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    },
  );
  return JSON.parse(stdout.trim());
}

async function runProcessSampler(shouldStop, samples, errors) {
  while (!shouldStop()) {
    const sampleStartedAt = Date.now();
    try {
      samples.push(await sampleChromeProcesses());
    } catch (error) {
      errors.push(String(error?.message || error));
    }
    const remainingMs = Math.max(
      0,
      processSampleMs - (Date.now() - sampleStartedAt),
    );
    await new Promise((resolve) => setTimeout(resolve, remainingMs));
  }
}

function percentile(values, quantile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[
    Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))
  ];
}

function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function summarizeProcessSamples(samples, hiddenStartedAt, hiddenEndedAt) {
  const valid = samples.filter(
    (sample) => sample.rootPid && sample.processes.length > 0,
  );
  const cpuSamples = [];
  let peakPrivateMB = 0;
  let peakWorkingSetMB = 0;
  for (let index = 0; index < valid.length; index += 1) {
    const sample = valid[index];
    peakPrivateMB = Math.max(
      peakPrivateMB,
      sample.processes.reduce(
        (total, processInfo) => total + processInfo.privateMB,
        0,
      ),
    );
    peakWorkingSetMB = Math.max(
      peakWorkingSetMB,
      sample.processes.reduce(
        (total, processInfo) => total + processInfo.workingSetMB,
        0,
      ),
    );
    if (index === 0) continue;
    const previous = valid[index - 1];
    const elapsedSeconds =
      (Date.parse(sample.capturedAt) - Date.parse(previous.capturedAt)) / 1000;
    if (!(elapsedSeconds > 0)) continue;
    const previousCpu = new Map(
      previous.processes.map((processInfo) => [
        processInfo.pid,
        processInfo.cpuSeconds,
      ]),
    );
    const cpuPercentByKind = {};
    for (const processInfo of sample.processes) {
      const priorCpuSeconds = previousCpu.get(processInfo.pid);
      if (priorCpuSeconds === undefined) continue;
      const percent =
        (Math.max(0, processInfo.cpuSeconds - priorCpuSeconds) /
          elapsedSeconds) *
        100;
      cpuPercentByKind[processInfo.kind] =
        (cpuPercentByKind[processInfo.kind] || 0) + percent;
    }
    cpuSamples.push({
      capturedAt: sample.capturedAt,
      aggregateCpuPercent: Object.values(cpuPercentByKind).reduce(
        (total, value) => total + value,
        0,
      ),
      cpuPercentByKind,
    });
  }
  const hiddenCpuSamples = cpuSamples.filter(
    (sample) =>
      hiddenStartedAt &&
      hiddenEndedAt &&
      Date.parse(sample.capturedAt) >= Date.parse(hiddenStartedAt) &&
      Date.parse(sample.capturedAt) <= Date.parse(hiddenEndedAt),
  );
  const steadyHiddenCpuSamples = hiddenCpuSamples.filter(
    (sample) =>
      Date.parse(sample.capturedAt) >= Date.parse(hiddenStartedAt) + 5000 &&
      Date.parse(sample.capturedAt) <= Date.parse(hiddenEndedAt) - 5000,
  );
  const values = cpuSamples.map((sample) => sample.aggregateCpuPercent);
  const hiddenValues = hiddenCpuSamples.map(
    (sample) => sample.aggregateCpuPercent,
  );
  const steadyHiddenValues = steadyHiddenCpuSamples.map(
    (sample) => sample.aggregateCpuPercent,
  );
  const peakCpuPercentByKind = {};
  for (const sample of hiddenCpuSamples) {
    for (const [kind, percent] of Object.entries(sample.cpuPercentByKind)) {
      peakCpuPercentByKind[kind] = Math.max(
        peakCpuPercentByKind[kind] || 0,
        percent,
      );
    }
  }
  return {
    sampleIntervalMs: processSampleMs,
    samples: valid.length,
    cpuSamples: cpuSamples.length,
    hiddenCpuSamples: hiddenCpuSamples.length,
    peakAggregateCpuPercent: values.length ? Math.max(...values) : null,
    p95AggregateCpuPercent: percentile(values, 0.95),
    hiddenPeakAggregateCpuPercent: hiddenValues.length
      ? Math.max(...hiddenValues)
      : null,
    hiddenP95AggregateCpuPercent: percentile(hiddenValues, 0.95),
    hiddenMedianAggregateCpuPercent: percentile(hiddenValues, 0.5),
    hiddenMeanAggregateCpuPercent: mean(hiddenValues),
    steadyHiddenGuardMs: 5000,
    steadyHiddenCpuSamples: steadyHiddenCpuSamples.length,
    steadyHiddenPeakAggregateCpuPercent: steadyHiddenValues.length
      ? Math.max(...steadyHiddenValues)
      : null,
    steadyHiddenP95AggregateCpuPercent: percentile(steadyHiddenValues, 0.95),
    steadyHiddenMedianAggregateCpuPercent: percentile(steadyHiddenValues, 0.5),
    steadyHiddenMeanAggregateCpuPercent: mean(steadyHiddenValues),
    hiddenSamplesOver50Percent: hiddenValues.filter((value) => value >= 50)
      .length,
    hiddenSamplesOver100Percent: hiddenValues.filter((value) => value >= 100)
      .length,
    hiddenPeakCpuPercentByKind: peakCpuPercentByKind,
    peakPrivateMB,
    peakWorkingSetMB,
    cpuSamplesByTimestamp: cpuSamples,
  };
}

const pageProbeSource = String.raw`
(() => {
  const state = {
    installedAt: new Date().toISOString(),
    visibility: [],
    lifecycle: [],
    reactivations: [],
    longTasks: [],
    rafGaps: [],
    heartbeat: 0,
    lastHeartbeatAt: null,
    errors: [],
  };
  const recordVisibility = (type) => {
    const activeSessionId = window.mmDebug?.activeId ?? null;
    const terminalState = activeSessionId
      ? window.mmDebug?.terminals?.get(activeSessionId)
      : null;
    const event = {
      type,
      at: new Date().toISOString(),
      performanceNow: performance.now(),
      state: document.visibilityState,
      hidden: document.hidden,
      focus: document.hasFocus(),
      activeSessionId,
      terminal: terminalState
        ? {
            hasWebgl: terminalState.hasWebgl === true,
            rows: terminalState.terminal?.rows ?? null,
            cols: terminalState.terminal?.cols ?? null,
            bufferLength: terminalState.terminal?.buffer?.active?.length ?? null,
          }
        : null,
    };
    state.visibility.push(event);
    if (event.state === "visible") {
      const reactivation = {
        visibilityAt: event.at,
        startedPerformanceNow: performance.now(),
        twoRaf: null,
      };
      state.reactivations.push(reactivation);
      const wallStartedAt = Date.now();
      const perfStartedAt = performance.now();
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          reactivation.twoRaf = {
            ok: true,
            completedAt: new Date().toISOString(),
            wallMs: Date.now() - wallStartedAt,
            performanceMs: performance.now() - perfStartedAt,
            visibilityState: document.visibilityState,
          };
        }),
      );
    }
  };
  recordVisibility("initial");
  document.addEventListener("visibilitychange", () =>
    recordVisibility("visibilitychange"),
  );
  for (const type of ["freeze", "resume", "pagehide", "pageshow"]) {
    addEventListener(type, (event) => {
      state.lifecycle.push({
        type,
        at: new Date().toISOString(),
        persisted: event.persisted ?? null,
      });
    });
  }
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        state.longTasks.push({
          at: new Date().toISOString(),
          startTime: entry.startTime,
          duration: entry.duration,
          name: entry.name,
        });
        if (state.longTasks.length > 5000) state.longTasks.shift();
      }
    });
    observer.observe({ type: "longtask", buffered: true });
  } catch (error) {
    state.errors.push(String(error && error.message || error));
  }
  let previousFrame = performance.now();
  const frame = (now) => {
    const gap = now - previousFrame;
    if (gap >= 50) {
      state.rafGaps.push({
        at: new Date().toISOString(),
        gapMs: gap,
        visibility: document.visibilityState,
      });
      if (state.rafGaps.length > 5000) state.rafGaps.shift();
    }
    previousFrame = now;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  setInterval(() => {
    state.heartbeat += 1;
    state.lastHeartbeatAt = new Date().toISOString();
  }, 1000);
  window.__tlbxDetachedProbe = state;
})();
`;

const snapshotExpression = String.raw`
(() => {
  const probe = window.__tlbxDetachedProbe;
  const activeSessionId = window.mmDebug?.activeId ?? null;
  const terminalState = activeSessionId
    ? window.mmDebug?.terminals?.get(activeSessionId)
    : null;
  return {
    capturedAt: new Date().toISOString(),
    visibilityState: document.visibilityState,
    hidden: document.hidden,
    focus: document.hasFocus(),
    title: document.title,
    href: location.href,
    innerWidth,
    innerHeight,
    maxTouchPoints: navigator.maxTouchPoints,
    activeSessionId,
    xtermCount: document.querySelectorAll(".xterm").length,
    canvasCount: document.querySelectorAll("canvas").length,
    graphNodeCount: document.querySelectorAll(".ag-node").length,
    domNodeCount: document.getElementsByTagName("*").length,
    bodyTextLength: document.body?.innerText?.length ?? 0,
    heap: performance.memory
      ? {
          usedJSHeapSize: performance.memory.usedJSHeapSize,
          totalJSHeapSize: performance.memory.totalJSHeapSize,
          jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
        }
      : null,
    terminal: terminalState
      ? {
          hasWebgl: terminalState.hasWebgl === true,
          rows: terminalState.terminal?.rows ?? null,
          cols: terminalState.terminal?.cols ?? null,
          bufferLength: terminalState.terminal?.buffer?.active?.length ?? null,
        }
      : null,
    probe,
  };
})()
`;

async function terminalContains(client, expected) {
  if (!expected) return null;
  return evaluate(
    client,
    `(() => {
      const id = window.mmDebug?.activeId ?? null;
      const terminal = id ? window.mmDebug?.terminals?.get(id)?.terminal : null;
      if (!terminal) return false;
      const buffer = terminal.buffer.active;
      for (let index = Math.max(0, buffer.length - 5000); index < buffer.length; index += 1) {
        if (buffer.getLine(index)?.translateToString(true).includes(${JSON.stringify(expected)})) {
          return true;
        }
      }
      return false;
    })()`,
  );
}

let chromeProcess;
let chromePort;
let chromeArgs = [];
let initialPageTargets = [];
let client;
let pageTargetId;
let createdSessionId;
let hiddenStartedAt;
let hiddenEndedAt;
let initialTargetEvidence;
let initialForegroundEvidence;
let setupForegroundEvidence;
let backgroundEvidence;
let backgroundTargetEvidence;
let backgroundVisibilityEvidence;
let minimizeEvidence;
let restoreEvidence;
let reactivationForegroundEvidence;
let before;
let after;
let immediateReactivationState;
let twoRaf;
let expectedTerminalTextVisible = null;
let serverBufferContainsExpected = null;
let screenshotCaptured = false;
let stopSampler = false;
let samplerPromise;
let errorText = null;
const processSamples = [];
const processSampleErrors = [];

console.log(`ARTIFACT_DIR=${runDir}`);
try {
  const launch = await launchChrome();
  chromeProcess = launch.child;
  chromePort = launch.port;
  chromeArgs = launch.args;
  samplerPromise = runProcessSampler(
    () => stopSampler,
    processSamples,
    processSampleErrors,
  );
  initialPageTargets = (await listTargets(chromePort))
    .filter((target) => target.type === "page")
    .map(({ id, title, url }) => ({ id, title, url }));
  console.log(`PAGE_TARGETS=${JSON.stringify(initialPageTargets)}`);
  const bootTarget = initialPageTargets.find((target) =>
    target.url.includes("TLBX_DETACHED_PROBE_BOOT"),
  );
  const pageTarget = await findPageTarget(chromePort, bootTarget?.id);
  pageTargetId = pageTarget.id;
  initialTargetEvidence = await switchChromeTarget(
    chromePort,
    "foreground",
    pageTargetId,
  );
  client = new CdpClient(pageTarget.webSocketDebuggerUrl);
  await client.ready;
  await Promise.all([
    client.send("Page.enable"),
    client.send("Runtime.enable"),
    client.send("Network.enable"),
  ]);
  for (const cookie of parseCookies(cookieHeader)) {
    const result = await client.send("Network.setCookie", cookie);
    if (result.success === false) {
      throw new Error(`Chrome rejected cookie ${cookie.name}.`);
    }
  }
  await client.send("Page.addScriptToEvaluateOnNewDocument", {
    source: pageProbeSource,
  });
  await client.send("Page.navigate", { url: targetUrl });
  await waitForExpression(
    client,
    "Boolean(document.querySelector('.terminal-page'))",
    30_000,
  );
  await client.send("Page.bringToFront");
  initialForegroundEvidence = await setChromeWindowState("restore", 3000);
  await waitForExpression(
    client,
    "document.visibilityState === 'visible' && !document.hidden",
    10_000,
  );
  createdSessionId = (
    await api(client, "/api/sessions", {
      method: "POST",
      body: JSON.stringify({ cols: 120, rows: 36, shell: "Pwsh" }),
    })
  ).id;
  await waitForExpression(
    client,
    `Boolean(document.querySelector('.session-item[data-session-id="${createdSessionId}"]'))`,
    15_000,
  );
  await evaluate(
    client,
    `document.querySelector('.session-item[data-session-id="${createdSessionId}"]').click()`,
  );
  await waitForExpression(
    client,
    `window.mmDebug?.activeId === ${JSON.stringify(createdSessionId)} && Boolean(document.querySelector('.xterm'))`,
    15_000,
  );
  if (backgroundCommand) {
    await api(
      client,
      `/api/sessions/${encodeURIComponent(createdSessionId)}/input/text`,
      {
        method: "POST",
        body: JSON.stringify({ text: backgroundCommand, appendNewline: true }),
      },
    );
  }
  if (warmupMs > 0) {
    console.log(`PHASE=warmup durationMs=${warmupMs}`);
    await new Promise((resolve) => setTimeout(resolve, warmupMs));
  }
  before = await evaluate(client, snapshotExpression);
  await client.close();
  client = null;

  setupForegroundEvidence =
    backgroundMode === "tab"
      ? null
      : await setChromeWindowState("restore-then-minimize", 3000);
  backgroundTargetEvidence =
    backgroundMode === "tab"
      ? await switchChromeTarget(chromePort, "background", pageTargetId)
      : null;
  backgroundVisibilityEvidence =
    backgroundMode === "tab"
      ? await readPageVisibility(chromePort, pageTargetId)
      : null;
  if (
    backgroundMode === "tab" &&
    backgroundVisibilityEvidence?.hidden !== true
  ) {
    throw new Error(
      `The tlbx target did not become hidden after the tab switch: ${JSON.stringify(backgroundVisibilityEvidence)}`,
    );
  }
  backgroundEvidence = backgroundTargetEvidence || setupForegroundEvidence;
  minimizeEvidence = setupForegroundEvidence || initialForegroundEvidence;
  hiddenStartedAt =
    backgroundTargetEvidence?.requestedAt ||
    setupForegroundEvidence?.minimizeRequestedAt ||
    new Date().toISOString();
  console.log(
    `PHASE=background mode=${backgroundMode} durationMs=${backgroundMs} pid=${minimizeEvidence.pid}`,
  );
  await new Promise((resolve) => setTimeout(resolve, backgroundMs));
  hiddenEndedAt = new Date().toISOString();
  if (backgroundMode === "tab") {
    restoreEvidence = await switchChromeTarget(
      chromePort,
      "foreground",
      pageTargetId,
      backgroundTargetEvidence?.targetId,
    );
    reactivationForegroundEvidence = restoreEvidence;
  } else {
    restoreEvidence = await setChromeWindowState("restore", 5000);
    reactivationForegroundEvidence = restoreEvidence;
  }
  console.log("PHASE=reactivation");

  const reactivatedTarget = await findPageTarget(
    chromePort,
    pageTargetId,
    15_000,
  );
  client = new CdpClient(reactivatedTarget.webSocketDebuggerUrl);
  await client.ready;
  await Promise.all([
    client.send("Page.enable"),
    client.send("Runtime.enable"),
  ]);
  try {
    immediateReactivationState = await evaluate(
      client,
      `({
        capturedAt: new Date().toISOString(),
        visibilityState: document.visibilityState,
        hidden: document.hidden,
        focus: document.hasFocus(),
        title: document.title,
        readyState: document.readyState,
        hasProbe: Boolean(window.__tlbxDetachedProbe),
        activeSessionId: window.mmDebug?.activeId ?? null,
      })`,
      { timeoutMs: 3000 },
    );
  } catch (error) {
    immediateReactivationState = {
      capturedAt: new Date().toISOString(),
      error: error?.message || String(error),
    };
  }
  const markerDeadline = Date.now() + 20_000;
  do {
    try {
      expectedTerminalTextVisible = await terminalContains(
        client,
        expectedTerminalText,
      );
    } catch {
      expectedTerminalTextVisible = false;
    }
    if (expectedTerminalTextVisible ?? true) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < markerDeadline);
  if (expectedTerminalText) {
    const buffer = await api(
      client,
      `/api/sessions/${encodeURIComponent(createdSessionId)}/buffer`,
    );
    serverBufferContainsExpected =
      JSON.stringify(buffer).includes(expectedTerminalText);
  }
  try {
    after = await evaluate(client, snapshotExpression, { timeoutMs: 5000 });
  } catch (error) {
    after = {
      capturedAt: new Date().toISOString(),
      error: error?.message || String(error),
    };
  }
  try {
    const screenshot = await client.send(
      "Page.captureScreenshot",
      { format: "png", fromSurface: true },
      15_000,
    );
    await fs.writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
    screenshotCaptured = true;
  } catch {
    screenshotCaptured = false;
  }
} catch (error) {
  errorText = error?.stack || String(error);
  console.error(errorText);
} finally {
  let cleanupClient = client;
  if (!cleanupClient && chromePort && pageTargetId) {
    try {
      const cleanupTarget = await findPageTarget(chromePort, pageTargetId, 5000);
      cleanupClient = new CdpClient(cleanupTarget.webSocketDebuggerUrl);
      await cleanupClient.ready;
      await cleanupClient.send("Runtime.enable");
    } catch {
      cleanupClient = null;
    }
  }
  if (createdSessionId) {
    await api(
      cleanupClient,
      `/api/sessions/${encodeURIComponent(createdSessionId)}`,
      { method: "DELETE" },
    ).catch(() => {});
  }
  if (cleanupClient && cleanupClient !== client) {
    await cleanupClient.close().catch(() => {});
  }
  if (client) await client.close().catch(() => {});
  stopSampler = true;
  if (samplerPromise) await samplerPromise.catch(() => {});
  const closedGracefully = await closeChromeGracefully(
    chromePort,
    chromeProcess,
  );
  if (!closedGracefully && chromeProcess && chromeProcess.exitCode === null) {
    chromeProcess.kill();
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

await fs.writeFile(
  processSamplesPath,
  `${JSON.stringify(processSamples, null, 2)}\n`,
  "utf8",
);
const chromeProcessProfile = summarizeProcessSamples(
  processSamples,
  hiddenStartedAt,
  hiddenEndedAt,
);
const visibilityTimeline = after?.probe?.visibility || [];
const reactivationTimeline = after?.probe?.reactivations || [];
const sawVisibleBeforeHidden = visibilityTimeline.some(
  (event) =>
    event.state === "visible" &&
    hiddenStartedAt &&
    Date.parse(event.at) < Date.parse(hiddenStartedAt),
);
const sawHidden = visibilityTimeline.some(
  (event) =>
    event.state === "hidden" &&
    event.type === "visibilitychange" &&
    hiddenStartedAt &&
    hiddenEndedAt &&
    Date.parse(event.at) >= Date.parse(hiddenStartedAt) &&
    Date.parse(event.at) <= Date.parse(hiddenEndedAt),
);
const sawVisibleAfterHidden = visibilityTimeline.some(
  (event) =>
    event.state === "visible" &&
    hiddenEndedAt &&
    Date.parse(event.at) >= Date.parse(hiddenEndedAt),
);
const measuredReactivation = reactivationTimeline.find(
  (entry) =>
    hiddenEndedAt &&
    Date.parse(entry.visibilityAt) >= Date.parse(hiddenEndedAt),
);
twoRaf = measuredReactivation?.twoRaf || {
  ok: false,
  error: "The detached page did not complete two RAFs after reactivation.",
};
const summary = {
  ok:
    !errorText &&
    sawVisibleBeforeHidden &&
    sawHidden &&
    sawVisibleAfterHidden &&
    twoRaf?.ok === true &&
    (expectedTerminalTextVisible ?? true),
  error: errorText,
  targetUrl,
  runDir,
  summaryPath,
  processSamplesPath,
  tracePath: traceEnabled ? tracePath : null,
  screenshotPath: screenshotCaptured ? screenshotPath : null,
  chromeStdoutPath,
  chromeStderrPath,
  launchMode: `standalone-google-chrome-raw-cdp-detached-while-hidden-${backgroundMode}`,
  chromePid: minimizeEvidence?.pid ?? null,
  chromePort,
  initialPageTargets,
  chromeArgs: chromeArgs.filter(
    (argument) => !argument.startsWith("--user-data-dir="),
  ),
  profileDir,
  warmupMs,
  backgroundMode,
  backgroundMs,
  processSampleMs,
  traceEnabled,
  backgroundCommandStarted: Boolean(backgroundCommand),
  expectedTerminalText,
  expectedTerminalTextVisible,
  serverBufferContainsExpected,
  createdSessionId,
  hiddenStartedAt,
  hiddenEndedAt,
  initialTargetEvidence,
  initialForegroundEvidence,
  setupForegroundEvidence,
  backgroundEvidence,
  backgroundTargetEvidence,
  backgroundVisibilityEvidence,
  minimizeEvidence,
  restoreEvidence,
  reactivationForegroundEvidence,
  before,
  after,
  lifecycleEvidence: {
    sawVisibleBeforeHidden,
    sawHidden,
    sawVisibleAfterHidden,
    visibilityTimeline,
    reactivationTimeline,
    lifecycleTimeline: after?.probe?.lifecycle || [],
    heartbeatBefore: before?.probe?.heartbeat ?? null,
    heartbeatAfter: after?.probe?.heartbeat ?? null,
    lastHeartbeatAt: after?.probe?.lastHeartbeatAt ?? null,
    longTaskCountBefore: before?.probe?.longTasks?.length ?? null,
    longTaskCountAfter: after?.probe?.longTasks?.length ?? null,
    maxLongTaskMs:
      after?.probe?.longTasks?.reduce(
        (maximum, entry) => Math.max(maximum, entry.duration),
        0,
      ) ?? null,
    rafGapCount: after?.probe?.rafGaps?.length ?? null,
    maxRafGapMs:
      after?.probe?.rafGaps?.reduce(
        (maximum, entry) => Math.max(maximum, entry.gapMs),
        0,
      ) ?? null,
  },
  reactivation: {
    immediateState: immediateReactivationState,
    twoRaf,
    terminalVisible: expectedTerminalTextVisible,
    serverBufferContainsExpected,
  },
  deltas: {
    heapUsedMB:
      before?.heap && after?.heap
        ? (after.heap.usedJSHeapSize - before.heap.usedJSHeapSize) / 1024 / 1024
        : null,
    domNodes: before && after ? after.domNodeCount - before.domNodeCount : null,
    bodyTextLength:
      before && after ? after.bodyTextLength - before.bodyTextLength : null,
    terminalBufferLines:
      before?.terminal?.bufferLength != null &&
      after?.terminal?.bufferLength != null
        ? after.terminal.bufferLength - before.terminal.bufferLength
        : null,
  },
  chromeProcessProfile,
  processSampleErrors,
};
await fs.writeFile(
  summaryPath,
  `${JSON.stringify(summary, null, 2)}\n`,
  "utf8",
);
console.log(`SUMMARY=${summaryPath}`);
console.log(
  `RESULT ok=${summary.ok} hidden=${sawHidden} visibleAfter=${sawVisibleAfterHidden} ` +
    `twoRafMs=${twoRaf?.wallMs ?? "n/a"} marker=${expectedTerminalTextVisible ?? "n/a"} ` +
    `hiddenPeakCpu=${chromeProcessProfile.hiddenPeakAggregateCpuPercent?.toFixed(1) ?? "n/a"}%`,
);
if (!summary.ok) process.exitCode = 1;
