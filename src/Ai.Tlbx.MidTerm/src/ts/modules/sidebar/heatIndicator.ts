/**
 * Heat Indicator Module
 *
 * Renders per-session thermal activity indicators as canvas strips
 * in the sidebar. Maps byte activity to color temperature:
 * red/orange (hot, active) → dark blue (cold, idle).
 *
 * Uses a single rAF loop for all sessions. Self-calibrating peak rate
 * ensures meaningful contrast even between sessions with different
 * baseline traffic levels.
 */

import { createLogger } from '../logging';

const log = createLogger('heat');

// =============================================================================
// Config
// =============================================================================

/** Peak rate decays slowly — forgets burst peaks over several minutes */
const PEAK_DECAY_PER_FRAME = 0.9998;

/** Minimum peak to avoid division by near-zero */
const MIN_PEAK = 200; // bytes/sec

/** Rate calculation interval in ms (fast for snappy heat-up, cooldown is slow via tri-exp) */
const RATE_INTERVAL_MS = 100;

/**
 * Tri-exponential cooldown curve.
 * Designed for monitoring 10+ AI agent sessions at a glance:
 *   - First third drops in 5-20s (recently went idle)
 *   - Middle third drops over 2-3 min (idle for a while)
 *   - Last third fades over ~15 min (long inactive)
 *
 * h(t) = W1·e^(-t/TAU1) + W2·e^(-t/TAU2) + W3·e^(-t/TAU3)
 */
const DECAY_FAST_W = 0.35;
const DECAY_FAST_TAU = 7; // seconds
const DECAY_MID_W = 0.35;
const DECAY_MID_TAU = 120; // seconds
const DECAY_SLOW_W = 0.3;
const DECAY_SLOW_TAU = 400; // seconds

/** Min heat value below which we skip drawing (avoids canvas ops when idle) */
const DRAW_THRESHOLD = 0.01;

/** CSS width of the indicator canvas in logical pixels */
const CANVAS_CSS_W = 4;

/** CSS height of the indicator canvas in logical pixels */
const CANVAS_CSS_H = 36;

// Color stops: [heat_value, r, g, b]
const GRADIENT: [number, number, number, number][] = [
  [0.0, 10, 14, 26], // dark navy (nearly invisible when idle)
  [0.25, 10, 48, 100], // medium blue
  [0.55, 180, 100, 0], // amber
  [0.78, 200, 60, 0], // orange
  [1.0, 200, 20, 0], // red
];

// =============================================================================
// State
// =============================================================================

interface SessionHeat {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  heat: number; // 0–1 current visual heat level
  peakRate: number; // self-calibrating max observed bytes/sec
  byteAccum: number; // bytes accumulated since last rate tick
  lastTickMs: number; // timestamp of last rate calculation
  lastActiveMs: number; // when last rate tick detected activity
  heatWhenInactive: number; // heat snapshot at deactivation (decay anchor)
  ignoreUntilMs: number; // suppress bytes until this timestamp (avoids false heat on session switch)
}

const sessions = new Map<string, SessionHeat>();
let rafId = 0;
let lastFrameMs = 0;

// =============================================================================
// Color math
// =============================================================================

function lerpColor(t: number): [number, number, number] {
  const stops = GRADIENT;
  if (t <= stops[0]![0]) return [stops[0]![1], stops[0]![2], stops[0]![3]];
  const last = stops[stops.length - 1]!;
  if (t >= last[0]) return [last[1], last[2], last[3]];

  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i]!;
    const b = stops[i + 1]!;
    if (t >= a[0] && t <= b[0]) {
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

// =============================================================================
// Canvas drawing
// =============================================================================

function drawCanvas(s: SessionHeat): void {
  const { ctx, heat } = s;

  ctx.clearRect(0, 0, CANVAS_CSS_W, CANVAS_CSS_H);

  if (heat < DRAW_THRESHOLD) return;

  const [r, g, b] = lerpColor(heat);
  const alpha = Math.min(1.0, heat * 2);

  // Height scales with heat (sqrt so it stays visible longer during cooldown)
  const heightFrac = Math.sqrt(heat);
  const visibleH = Math.max(4, heightFrac * CANVAS_CSS_H);
  const offsetY = (CANVAS_CSS_H - visibleH) / 2;

  // Gradient from center outward — brightest in the middle, fading to both edges
  const gradient = ctx.createLinearGradient(0, offsetY, 0, offsetY + visibleH);
  const edgeAlpha = (alpha * 0.15).toFixed(3);
  const coreAlpha = alpha.toFixed(3);
  gradient.addColorStop(0, `rgba(${r},${g},${b},${edgeAlpha})`);
  gradient.addColorStop(0.35, `rgba(${r},${g},${b},${coreAlpha})`);
  gradient.addColorStop(0.65, `rgba(${r},${g},${b},${coreAlpha})`);
  gradient.addColorStop(1.0, `rgba(${r},${g},${b},${edgeAlpha})`);

  ctx.fillStyle = gradient;

  // Draw pill shape at calculated position
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

// =============================================================================
// Decay curve
// =============================================================================

function triExpDecay(seconds: number): number {
  return (
    DECAY_FAST_W * Math.exp(-seconds / DECAY_FAST_TAU) +
    DECAY_MID_W * Math.exp(-seconds / DECAY_MID_TAU) +
    DECAY_SLOW_W * Math.exp(-seconds / DECAY_SLOW_TAU)
  );
}

// =============================================================================
// Animation loop
// =============================================================================

function drawFrame(nowMs: number): void {
  rafId = requestAnimationFrame(drawFrame);

  const dt = nowMs - lastFrameMs;
  lastFrameMs = nowMs;

  const frames = Math.min(dt / 16.67, 4);
  const peakDecay = Math.pow(PEAK_DECAY_PER_FRAME, frames);

  sessions.forEach((s) => {
    // Periodically recalculate byte rate and update heat
    const elapsed = nowMs - s.lastTickMs;
    if (elapsed >= RATE_INTERVAL_MS) {
      const rate = (s.byteAccum / elapsed) * 1000; // bytes/sec
      s.byteAccum = 0;
      s.lastTickMs = nowMs;

      // Self-calibrate: peak tracks the max rate, decays slowly over time
      s.peakRate = Math.max(
        MIN_PEAK,
        Math.max(rate, s.peakRate * Math.pow(peakDecay, elapsed / 16.67)),
      );

      // Add heat proportional to current rate vs peak
      if (rate > 0) {
        const normalized = Math.min(1.0, rate / s.peakRate);
        s.heat = Math.min(1.0, s.heat + normalized * 0.8);
        s.lastActiveMs = nowMs;
        s.heatWhenInactive = s.heat;
      }
    }

    // Tri-exponential cooldown (grace period of one rate interval before decay starts)
    const inactiveMs = nowMs - s.lastActiveMs;
    if (inactiveMs > RATE_INTERVAL_MS) {
      const inactiveSec = (inactiveMs - RATE_INTERVAL_MS) / 1000;
      s.heat = s.heatWhenInactive * triExpDecay(inactiveSec);
    }

    drawCanvas(s);
  });
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Register a canvas element to display the heat indicator for a session.
 * Sets up the canvas buffer dimensions accounting for device pixel ratio.
 */
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

  sessions.set(sessionId, {
    canvas,
    ctx,
    heat: 0,
    peakRate: MIN_PEAK,
    byteAccum: 0,
    lastTickMs: performance.now(),
    lastActiveMs: 0,
    heatWhenInactive: 0,
    ignoreUntilMs: 0,
  });
}

/**
 * Unregister and clean up a session's heat indicator.
 */
export function unregisterHeatCanvas(sessionId: string): void {
  sessions.delete(sessionId);
}

/**
 * Record incoming bytes for a session. Called from the mux channel
 * whenever an output frame arrives for this session.
 */
export function recordBytes(sessionId: string, bytes: number): void {
  const s = sessions.get(sessionId);
  if (!s) return;
  if (s.ignoreUntilMs > performance.now()) return;
  s.byteAccum += bytes;
}

/**
 * Suppress heat recording for a session for a short duration.
 * Used when switching active sessions — the server flushes its background
 * buffer which would falsely heat up an idle session.
 */
export function suppressHeat(sessionId: string, durationMs: number): void {
  const s = sessions.get(sessionId);
  if (s) {
    s.ignoreUntilMs = performance.now() + durationMs;
  }
}

/**
 * Start the shared animation loop for all heat indicators.
 */
export function initHeatIndicator(): void {
  if (rafId) return;
  lastFrameMs = performance.now();
  rafId = requestAnimationFrame(drawFrame);
}

/**
 * Stop the animation loop and remove all session state.
 */
export function destroyHeatIndicator(): void {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
  sessions.clear();
}
