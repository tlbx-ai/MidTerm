/**
 * Streams a Chrome JSON trace without loading the full file into memory.
 *
 * Usage:
 *   node scripts/perf/analyze-chrome-trace.mjs <trace.json> [summary.json] [output.json]
 *
 * When a detached-probe summary is supplied, wall-clock visibility events are
 * mapped onto trace timestamps so hidden WebSocket traffic and main-thread work
 * can be compared directly.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

const tracePath = process.argv[2];
if (!tracePath) {
  throw new Error(
    "Usage: node scripts/perf/analyze-chrome-trace.mjs <chrome-trace.json>",
  );
}

const profileSummaryPath = process.argv[3]?.endsWith("summary.json")
  ? process.argv[3]
  : null;
const outputPath =
  (profileSummaryPath ? process.argv[4] : process.argv[3]) ||
  path.join(path.dirname(tracePath), "trace-summary.json");
const profileSummary = profileSummaryPath
  ? JSON.parse(await fsp.readFile(profileSummaryPath, "utf8"))
  : null;
const hiddenVisibilityEvent =
  profileSummary?.lifecycleEvidence?.visibilityTimeline?.find(
    (event) =>
      event.type === "visibilitychange" &&
      event.state === "hidden" &&
      Date.parse(event.at) >= Date.parse(profileSummary.hiddenStartedAt) &&
      Date.parse(event.at) <= Date.parse(profileSummary.hiddenEndedAt),
  ) || null;
const visibleAfterHiddenEvent =
  profileSummary?.lifecycleEvidence?.visibilityTimeline?.find(
    (event) =>
      event.type === "visibilitychange" &&
      event.state === "visible" &&
      Date.parse(event.at) >= Date.parse(profileSummary.hiddenEndedAt),
  ) || null;
const processNames = new Map();
const threadNames = new Map();
const completeEvents = [];
const hiddenCompleteEvents = [];
const aggregate = new Map();
const taskAggregate = new Map();
const hiddenAggregate = new Map();
const hiddenTaskAggregate = new Map();
const webSocketUrls = new Map();
const hiddenWebSockets = new Map();
let targetNavigation = null;
let hiddenTraceRangeUs = null;
let eventsSeen = 0;
let completeEventsSeen = 0;
let minimumTimestamp = Number.POSITIVE_INFINITY;
let maximumTimestamp = Number.NEGATIVE_INFINITY;

function identity(pid, tid) {
  return `${pid}:${tid}`;
}

function webSocketIdentity(pid, identifier) {
  return `${pid}:${identifier}`;
}

function addAggregate(target, key, durationUs) {
  const entry = target.get(key) || {
    count: 0,
    totalDurationUs: 0,
    maxDurationUs: 0,
  };
  entry.count += 1;
  entry.totalDurationUs += durationUs;
  entry.maxDurationUs = Math.max(entry.maxDurationUs, durationUs);
  target.set(key, entry);
}

function parseEventLine(line) {
  let candidate = line.trim();
  if (
    !candidate.startsWith("{") ||
    candidate.startsWith('{"traceEvents"') ||
    candidate.startsWith('{"metadata"')
  ) {
    return null;
  }
  if (candidate.endsWith(",")) candidate = candidate.slice(0, -1);
  if (!candidate.endsWith("}")) return null;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

const input = fs.createReadStream(tracePath, { encoding: "utf8" });
const lines = readline.createInterface({ input, crlfDelay: Infinity });
for await (const line of lines) {
  const event = parseEventLine(line);
  if (!event) continue;
  eventsSeen += 1;
  if (event.ph === "M" && event.name === "process_name" && event.args?.name) {
    processNames.set(event.pid, event.args.name);
    continue;
  }
  if (event.ph === "M" && event.name === "thread_name" && event.args?.name) {
    threadNames.set(identity(event.pid, event.tid), event.args.name);
    continue;
  }
  if (
    event.name === "navigationStart" &&
    event.args?.data?.documentLoaderURL === profileSummary?.targetUrl
  ) {
    targetNavigation = {
      timestampUs: event.ts,
      pid: event.pid,
      tid: event.tid,
      url: event.args.data.documentLoaderURL,
    };
    if (hiddenVisibilityEvent && visibleAfterHiddenEvent) {
      hiddenTraceRangeUs = {
        start: event.ts + Number(hiddenVisibilityEvent.performanceNow) * 1000,
        end: event.ts + Number(visibleAfterHiddenEvent.performanceNow) * 1000,
      };
      hiddenTraceRangeUs.durationSeconds =
        (hiddenTraceRangeUs.end - hiddenTraceRangeUs.start) / 1_000_000;
    }
  }
  if (
    event.name === "WebSocketCreate" &&
    event.args?.data?.identifier != null
  ) {
    const identifier = event.args.data.identifier;
    webSocketUrls.set(webSocketIdentity(event.pid, identifier), {
      pid: event.pid,
      identifier,
      url: event.args.data.url || "unknown",
      createdAtUs: event.ts,
      destroyedAtUs: null,
    });
  }
  if (
    event.name === "WebSocketDestroy" &&
    event.args?.data?.identifier != null
  ) {
    const identifier = event.args.data.identifier;
    const socket = webSocketUrls.get(webSocketIdentity(event.pid, identifier));
    if (socket) socket.destroyedAtUs = event.ts;
  }
  if (
    hiddenTraceRangeUs &&
    event.ts >= hiddenTraceRangeUs.start &&
    event.ts <= hiddenTraceRangeUs.end &&
    ["WebSocketReceive", "WebSocketSend", "WebSocketDestroy"].includes(
      event.name,
    ) &&
    event.args?.data?.identifier != null
  ) {
    const identifier = event.args.data.identifier;
    const socketKey = webSocketIdentity(event.pid, identifier);
    const entry = hiddenWebSockets.get(socketKey) || {
      pid: event.pid,
      identifier,
      url: webSocketUrls.get(socketKey)?.url || "unknown",
      receiveFrames: 0,
      receiveBytes: 0,
      sendFrames: 0,
      sendBytes: 0,
      destroys: 0,
    };
    if (event.name === "WebSocketReceive") {
      entry.receiveFrames += 1;
      entry.receiveBytes += Number(event.args.data.dataLength || 0);
    } else if (event.name === "WebSocketSend") {
      entry.sendFrames += 1;
      entry.sendBytes += Number(event.args.data.dataLength || 0);
    } else {
      entry.destroys += 1;
    }
    hiddenWebSockets.set(socketKey, entry);
  }
  if (event.ph !== "X" || !(event.dur >= 0) || !(event.ts >= 0)) continue;
  completeEventsSeen += 1;
  minimumTimestamp = Math.min(minimumTimestamp, event.ts);
  maximumTimestamp = Math.max(maximumTimestamp, event.ts + event.dur);
  const processName = processNames.get(event.pid) || `pid:${event.pid}`;
  const threadName =
    threadNames.get(identity(event.pid, event.tid)) || `tid:${event.tid}`;
  const category = event.cat || "";
  const aggregateKey = JSON.stringify([
    processName,
    threadName,
    category,
    event.name,
  ]);
  addAggregate(aggregate, aggregateKey, event.dur);
  if (/RunTask|TaskQueue|ThreadController|MessagePump/.test(event.name)) {
    addAggregate(taskAggregate, aggregateKey, event.dur);
  }
  const hiddenOverlapUs = hiddenTraceRangeUs
    ? Math.max(
        0,
        Math.min(event.ts + event.dur, hiddenTraceRangeUs.end) -
          Math.max(event.ts, hiddenTraceRangeUs.start),
      )
    : 0;
  if (hiddenOverlapUs > 0) {
    addAggregate(hiddenAggregate, aggregateKey, hiddenOverlapUs);
    if (/RunTask|TaskQueue|ThreadController|MessagePump/.test(event.name)) {
      addAggregate(hiddenTaskAggregate, aggregateKey, hiddenOverlapUs);
    }
  }
  if (event.dur >= 10_000) {
    const serialized = {
      timestampUs: event.ts,
      durationMs: event.dur / 1000,
      processName,
      threadName,
      category,
      name: event.name,
      pid: event.pid,
      tid: event.tid,
    };
    completeEvents.push(serialized);
    if (hiddenOverlapUs > 0) {
      hiddenCompleteEvents.push({
        ...serialized,
        hiddenOverlapMs: hiddenOverlapUs / 1000,
      });
    }
  }
}

function serializeAggregate(source, limit) {
  return [...source.entries()]
    .map(([rawKey, value]) => {
      const [processName, threadName, category, name] = JSON.parse(rawKey);
      return {
        processName,
        threadName,
        category,
        name,
        count: value.count,
        totalDurationMs: value.totalDurationUs / 1000,
        maxDurationMs: value.maxDurationUs / 1000,
      };
    })
    .sort((left, right) => right.totalDurationMs - left.totalDurationMs)
    .slice(0, limit);
}

const rendererMainLongEvents = completeEvents
  .filter((event) => event.threadName === "CrRendererMain")
  .sort((left, right) => right.durationMs - left.durationMs)
  .slice(0, 100);
const browserMainLongEvents = completeEvents
  .filter((event) => event.threadName === "CrBrowserMain")
  .sort((left, right) => right.durationMs - left.durationMs)
  .slice(0, 100);
const summary = {
  tracePath,
  outputPath,
  traceBytes: (await fsp.stat(tracePath)).size,
  eventsSeen,
  completeEventsSeen,
  traceTimestampRangeUs:
    Number.isFinite(minimumTimestamp) && Number.isFinite(maximumTimestamp)
      ? {
          start: minimumTimestamp,
          end: maximumTimestamp,
          durationSeconds: (maximumTimestamp - minimumTimestamp) / 1_000_000,
        }
      : null,
  profileSummaryPath,
  targetNavigation,
  hiddenTraceRangeUs,
  knownWebSockets: [...webSocketUrls.values()].sort((left, right) =>
    left.url.localeCompare(right.url),
  ),
  hiddenWebSockets: [...hiddenWebSockets.values()].sort(
    (left, right) =>
      right.receiveBytes +
      right.sendBytes -
      (left.receiveBytes + left.sendBytes),
  ),
  processes: Object.fromEntries(processNames),
  threads: Object.fromEntries(threadNames),
  longestCompleteEvents: completeEvents
    .sort((left, right) => right.durationMs - left.durationMs)
    .slice(0, 100),
  rendererMainLongEvents,
  browserMainLongEvents,
  hiddenLongestCompleteEvents: hiddenCompleteEvents
    .sort((left, right) => right.hiddenOverlapMs - left.hiddenOverlapMs)
    .slice(0, 100),
  hiddenRendererMainLongEvents: hiddenCompleteEvents
    .filter((event) => event.threadName === "CrRendererMain")
    .sort((left, right) => right.hiddenOverlapMs - left.hiddenOverlapMs)
    .slice(0, 100),
  hiddenBrowserMainLongEvents: hiddenCompleteEvents
    .filter((event) => event.threadName === "CrBrowserMain")
    .sort((left, right) => right.hiddenOverlapMs - left.hiddenOverlapMs)
    .slice(0, 100),
  topTaskAggregates: serializeAggregate(taskAggregate, 100),
  topEventAggregates: serializeAggregate(aggregate, 100),
  hiddenTopTaskAggregates: serializeAggregate(hiddenTaskAggregate, 100),
  hiddenTopEventAggregates: serializeAggregate(hiddenAggregate, 100),
};
await fsp.writeFile(
  outputPath,
  `${JSON.stringify(summary, null, 2)}\n`,
  "utf8",
);
console.log(`TRACE_SUMMARY=${outputPath}`);
console.log(
  `RESULT events=${eventsSeen} complete=${completeEventsSeen} ` +
    `rendererLong=${rendererMainLongEvents.length} browserLong=${browserMainLongEvents.length}`,
);
