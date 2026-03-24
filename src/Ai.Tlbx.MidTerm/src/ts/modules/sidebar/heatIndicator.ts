/**
 * Heat Indicator Module
 *
 * Renders per-session thermal activity indicators as canvas strips in the
 * sidebar. Heat is sourced from server-side session telemetry so it reflects
 * actual mthost-produced output rather than browser-side mux replay noise.
 */

import { getSessions } from '../../api/client';
import { createLogger } from '../logging';

const log = createLogger('heat');

const POLL_INTERVAL_MS = 1000;
const DRAW_THRESHOLD = 0.003;
const CANVAS_CSS_W = 4;
const CANVAS_CSS_H = 36;
const RISE_TIME_CONSTANT_MS = 90;
const BACKGROUND_SYNC_THRESHOLD_MS = 250;
// Decay targets:
// - 1.0 -> ~0.25 in 30s so idle sessions still keep a visible hierarchy
// - effectively gone after roughly 2 minutes
const FALL_TIME_CONSTANT_MS = 30_000 / Math.log(4);
const ANIMATION_SNAP_THRESHOLD = 0.002;

// Color stops: [heat_value, r, g, b]
const GRADIENT: [number, number, number, number][] = [
  [0.0, 10, 14, 26],
  [0.18, 18, 54, 102],
  [0.4, 92, 198, 255],
  [0.58, 170, 232, 255],
  [0.66, 220, 78, 104],
  [0.84, 224, 44, 52],
  [1.0, 220, 28, 28],
];

const COLOR_LUT_SIZE = 101;
const colorLUT: [number, number, number][] = new Array<[number, number, number]>(COLOR_LUT_SIZE);

interface SessionHeat {
  canvas: HTMLCanvasElement | null;
  ctx: CanvasRenderingContext2D | null;
  heat: number;
  activityHeat: number;
  displayHeat: number;
  lastDrawnHeat: number;
  lastActivityAtMs: number | null;
  lastDisplayUpdateAtMs: number;
}

const sessions = new Map<string, SessionHeat>();
let pollTimerId: number | null = null;
let pollInFlight = false;
let animationFrameId: number | null = null;

function clampHeat(heat: number): number {
  if (!Number.isFinite(heat)) {
    return 0;
  }

  return Math.max(0, Math.min(1, heat));
}

function lerpColorRaw(t: number): [number, number, number] {
  const stops = GRADIENT;
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (!first || !last) return [10, 14, 26];
  if (t <= first[0]) return [first[1], first[2], first[3]];
  if (t >= last[0]) return [last[1], last[2], last[3]];

  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (a && b && t >= a[0] && t <= b[0]) {
      const f = (t - a[0]) / (b[0] - a[0]);
      return [
        Math.round(a[1] + (b[1] - a[1]) * f),
        Math.round(a[2] + (b[2] - a[2]) * f),
        Math.round(a[3] + (b[3] - a[3]) * f),
      ];
    }
  }

  return [10, 14, 26];
}

function buildColorLUT(): void {
  for (let i = 0; i < COLOR_LUT_SIZE; i++) {
    colorLUT[i] = lerpColorRaw(i / (COLOR_LUT_SIZE - 1));
  }
}

function lerpColor(t: number): [number, number, number] {
  const index = Math.min(COLOR_LUT_SIZE - 1, Math.max(0, Math.round(t * (COLOR_LUT_SIZE - 1))));
  return colorLUT[index] ?? [10, 14, 26];
}

function getNowMs(): number {
  return Date.now();
}

function parseActivityTimestampMs(
  timestamp: string | number | Date | null | undefined,
): number | null {
  if (timestamp instanceof Date) {
    const dateMs = timestamp.getTime();
    return Number.isFinite(dateMs) ? dateMs : null;
  }

  if (typeof timestamp === 'number') {
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  if (typeof timestamp === 'string' && timestamp.trim().length > 0) {
    const parsedMs = Date.parse(timestamp);
    return Number.isFinite(parsedMs) ? parsedMs : null;
  }

  return null;
}

function getTargetHeatAt(state: SessionHeat, nowMs: number): number {
  if (state.lastActivityAtMs === null) {
    return state.heat;
  }

  const elapsedMs = Math.max(0, nowMs - state.lastActivityAtMs);
  return clampHeat(state.activityHeat * Math.exp(-elapsedMs / FALL_TIME_CONSTANT_MS));
}

function syncDisplayHeat(state: SessionHeat, nowMs: number, snapToTarget: boolean = false): void {
  const previousUpdateAtMs = state.lastDisplayUpdateAtMs || nowMs;
  const elapsedMs = Math.max(0, nowMs - previousUpdateAtMs);
  const targetHeat = getTargetHeatAt(state, nowMs);

  if (
    snapToTarget ||
    elapsedMs >= BACKGROUND_SYNC_THRESHOLD_MS ||
    targetHeat <= state.displayHeat
  ) {
    state.displayHeat = targetHeat;
  } else {
    const blend = 1 - Math.exp(-elapsedMs / RISE_TIME_CONSTANT_MS);
    state.displayHeat = clampHeat(state.displayHeat + (targetHeat - state.displayHeat) * blend);
    if (Math.abs(state.displayHeat - targetHeat) <= ANIMATION_SNAP_THRESHOLD) {
      state.displayHeat = targetHeat;
    }
  }

  state.lastDisplayUpdateAtMs = nowMs;
}

function shouldAnimateState(state: SessionHeat, nowMs: number): boolean {
  if (!state.ctx) {
    return false;
  }

  const targetHeat = getTargetHeatAt(state, nowMs);
  return (
    targetHeat >= DRAW_THRESHOLD ||
    Math.abs(state.displayHeat - targetHeat) > ANIMATION_SNAP_THRESHOLD
  );
}

function drawCanvas(s: SessionHeat): void {
  const { ctx, displayHeat: heat } = s;
  if (!ctx) return;

  if (heat < DRAW_THRESHOLD) {
    if (s.lastDrawnHeat >= DRAW_THRESHOLD) {
      ctx.clearRect(0, 0, CANVAS_CSS_W, CANVAS_CSS_H);
      s.lastDrawnHeat = heat;
    }
    return;
  }

  if (Math.abs(heat - s.lastDrawnHeat) < 0.005) return;

  s.lastDrawnHeat = heat;
  ctx.clearRect(0, 0, CANVAS_CSS_W, CANVAS_CSS_H);

  const [r, g, b] = lerpColor(heat);
  const alpha = Math.min(1.0, heat * 2);
  const heightFrac = Math.sqrt(heat);
  const visibleH = Math.max(4, heightFrac * CANVAS_CSS_H);
  const offsetY = (CANVAS_CSS_H - visibleH) / 2;

  const gradient = ctx.createLinearGradient(0, offsetY, 0, offsetY + visibleH);
  const edgeAlpha = (alpha * 0.15).toFixed(3);
  const coreAlpha = alpha.toFixed(3);
  gradient.addColorStop(0, `rgba(${r},${g},${b},${edgeAlpha})`);
  gradient.addColorStop(0.35, `rgba(${r},${g},${b},${coreAlpha})`);
  gradient.addColorStop(0.65, `rgba(${r},${g},${b},${coreAlpha})`);
  gradient.addColorStop(1.0, `rgba(${r},${g},${b},${edgeAlpha})`);

  ctx.fillStyle = gradient;

  const radius = Math.min(CANVAS_CSS_W / 2, visibleH / 2);
  ctx.beginPath();
  ctx.moveTo(radius, offsetY);
  ctx.arcTo(CANVAS_CSS_W, offsetY, CANVAS_CSS_W, offsetY + visibleH, radius);
  ctx.arcTo(CANVAS_CSS_W, offsetY + visibleH, 0, offsetY + visibleH, radius);
  ctx.arcTo(0, offsetY + visibleH, 0, offsetY, radius);
  ctx.arcTo(0, offsetY, CANVAS_CSS_W, offsetY, radius);
  ctx.closePath();
  ctx.fill();
}

function getOrCreateSessionHeat(sessionId: string): SessionHeat {
  let state = sessions.get(sessionId);
  if (!state) {
    state = {
      canvas: null,
      ctx: null,
      heat: 0,
      activityHeat: 0,
      displayHeat: 0,
      lastDrawnHeat: 0,
      lastActivityAtMs: null,
      lastDisplayUpdateAtMs: getNowMs(),
    };
    sessions.set(sessionId, state);
  }

  return state;
}

function scheduleAnimation(): void {
  if (document.hidden || animationFrameId !== null) {
    return;
  }

  animationFrameId = window.requestAnimationFrame(stepAnimation);
}

function stepAnimation(_timestamp: number): void {
  animationFrameId = null;
  const nowMs = getNowMs();

  let needsAnotherFrame = false;
  for (const state of sessions.values()) {
    syncDisplayHeat(state, nowMs);
    drawCanvas(state);
    needsAnotherFrame = shouldAnimateState(state, nowMs) || needsAnotherFrame;
  }

  if (needsAnotherFrame) {
    animationFrameId = window.requestAnimationFrame(stepAnimation);
  }
}

function applyHeat(
  sessionId: string,
  heat: number,
  lastActivityAt?: string | number | Date | null,
): void {
  const state = getOrCreateSessionHeat(sessionId);
  const nextHeat = clampHeat(heat);
  const nowMs = getNowMs();
  const parsedActivityAtMs = parseActivityTimestampMs(lastActivityAt);
  const nextActivityAtMs = parsedActivityAtMs ?? (nextHeat > 0 ? nowMs : state.lastActivityAtMs);
  const nextActivityHeat = nextHeat > 0 ? nextHeat : state.activityHeat;

  if (
    Math.abs(state.heat - nextHeat) < 0.0001 &&
    state.lastActivityAtMs === nextActivityAtMs &&
    Math.abs(state.activityHeat - nextActivityHeat) < 0.0001
  ) {
    return;
  }

  state.heat = nextHeat;
  state.activityHeat = nextActivityHeat;
  state.lastActivityAtMs = nextActivityAtMs;

  syncDisplayHeat(state, nowMs, document.hidden || !state.ctx);

  if (!state.ctx) {
    state.lastDrawnHeat = -1;
    return;
  }

  drawCanvas(state);
  if (shouldAnimateState(state, nowMs)) {
    scheduleAnimation();
  }
}

async function refreshHeatFromServer(): Promise<void> {
  if (pollInFlight || sessions.size === 0) {
    return;
  }

  pollInFlight = true;
  try {
    const { data, response } = await getSessions();
    if (!response.ok || !data) {
      return;
    }

    const activeIds = new Set<string>();
    for (const session of data.sessions) {
      activeIds.add(session.id);
      applyHeat(
        session.id,
        session.supervisor?.currentHeat ?? 0,
        session.supervisor?.lastOutputAt ?? null,
      );
    }

    for (const sessionId of sessions.keys()) {
      if (!activeIds.has(sessionId)) {
        applyHeat(sessionId, 0);
      }
    }
  } catch (error) {
    log.verbose(() => `Heat refresh skipped: ${String(error)}`);
  } finally {
    pollInFlight = false;
  }
}

buildColorLUT();

export function registerHeatCanvas(sessionId: string, canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    log.warn(() => `No 2D context for heat canvas, session ${sessionId}`);
    return;
  }

  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(CANVAS_CSS_W * dpr);
  canvas.height = Math.round(CANVAS_CSS_H * dpr);
  ctx.scale(dpr, dpr);

  const state = getOrCreateSessionHeat(sessionId);
  state.canvas = canvas;
  state.ctx = ctx;
  state.lastDrawnHeat = -1;
  syncDisplayHeat(state, getNowMs(), document.hidden);

  if (!document.hidden) {
    drawCanvas(state);
    if (shouldAnimateState(state, getNowMs())) {
      scheduleAnimation();
    }
  }
}

export function unregisterHeatCanvas(sessionId: string): void {
  const state = sessions.get(sessionId);
  if (!state) return;

  state.canvas = null;
  state.ctx = null;
  state.lastDrawnHeat = -1;
}

export function pruneHeatSessions(sessionIds: Iterable<string>): void {
  const validIds = new Set(sessionIds);
  for (const sessionId of sessions.keys()) {
    if (!validIds.has(sessionId)) {
      sessions.delete(sessionId);
    }
  }
}

export function setSessionHeat(sessionId: string, heat: number): void {
  applyHeat(sessionId, heat);
}

export function recordBytes(_sessionId: string, _bytes: number): void {
  // Sidebar heat is sourced from server telemetry. Byte-based browser heuristics
  // remain available elsewhere (for example mobile PiP), but not for this strip.
}

export function getSessionHeat(sessionId: string): number {
  return sessions.get(sessionId)?.heat ?? 0;
}

export function getDisplayedSessionHeat(sessionId: string): number {
  return sessions.get(sessionId)?.displayHeat ?? 0;
}

export function suppressAllHeat(_durationMs: number): void {
  // No-op: server-side heat is not driven by browser-side replay or refresh traffic.
}

export function initHeatIndicator(): void {
  if (pollTimerId !== null) {
    return;
  }

  void refreshHeatFromServer();
  pollTimerId = window.setInterval(() => {
    void refreshHeatFromServer();
  }, POLL_INTERVAL_MS);

  document.addEventListener('visibilitychange', () => {
    const nowMs = getNowMs();
    sessions.forEach((state) => {
      syncDisplayHeat(state, nowMs, true);
    });

    if (document.hidden) {
      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
      }
      return;
    }

    void refreshHeatFromServer();
    sessions.forEach((state) => {
      drawCanvas(state);
    });
    scheduleAnimation();
  });
}

export function destroyHeatIndicator(): void {
  if (pollTimerId !== null) {
    window.clearInterval(pollTimerId);
    pollTimerId = null;
  }

  if (animationFrameId !== null) {
    window.cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }

  sessions.clear();
}
