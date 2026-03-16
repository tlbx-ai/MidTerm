/**
 * Heat Indicator Module
 *
 * Renders per-session thermal activity indicators as canvas strips
 * in the sidebar. Maps byte activity to color temperature:
 * hot red (active) → ice blue (cooling) → dark blue (idle).
 *
 * Uses a single rAF loop for all sessions. Self-calibrating peak rate
 * ensures meaningful contrast even between sessions with different
 * baseline traffic levels.
 *
 * Performance: self-pausing rAF (stops when all idle), pre-computed
 * decay + color LUTs, dirty-tracking to skip redundant draws,
 * document.hidden awareness.
 */

import { createLogger } from '../logging';

const log = createLogger('heat');

// =============================================================================
// Config
// =============================================================================

/** Peak rate half-life in seconds (~57s, matching original 0.9998/frame at 60fps) */
const PEAK_HALF_LIFE_SEC = 57;

/** Minimum peak to avoid division by near-zero */
const MIN_PEAK = 200; // bytes/sec

/** Minimum rate (bytes/sec) to register as activity — filters focus event noise */
const MIN_RATE = 100;

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
  [0.18, 18, 54, 102], // deep cold blue
  [0.4, 92, 198, 255], // ice blue
  [0.58, 170, 232, 255], // bright frost blue
  [0.66, 220, 78, 104], // warm transition without orange
  [0.84, 224, 44, 52], // strong red sooner so hot sessions cool visually more gradually
  [1.0, 220, 28, 28], // hot red
];

// =============================================================================
// Pre-computed lookup tables
// =============================================================================

const DECAY_LUT_SIZE = 1000;
const DECAY_LUT_STEP = 0.1; // seconds per entry (covers 0–100s)
const decayLUT = new Float32Array(DECAY_LUT_SIZE);

const COLOR_LUT_SIZE = 101;
const colorLUT: [number, number, number][] = new Array<[number, number, number]>(COLOR_LUT_SIZE);

function buildDecayLUT(): void {
  for (let i = 0; i < DECAY_LUT_SIZE; i++) {
    const t = i * DECAY_LUT_STEP;
    decayLUT[i] =
      DECAY_FAST_W * Math.exp(-t / DECAY_FAST_TAU) +
      DECAY_MID_W * Math.exp(-t / DECAY_MID_TAU) +
      DECAY_SLOW_W * Math.exp(-t / DECAY_SLOW_TAU);
  }
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

buildDecayLUT();
buildColorLUT();

// =============================================================================
// State
// =============================================================================

interface SessionHeat {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  heat: number; // 0–1 current visual heat level
  lastDrawnHeat: number; // heat value last rendered (dirty tracking)
  peakRate: number; // self-calibrating max observed bytes/sec
  byteAccum: number; // bytes accumulated since last rate tick
  lastTickMs: number; // timestamp of last rate calculation
  lastActiveMs: number; // when last rate tick detected activity
  heatWhenInactive: number; // heat snapshot at deactivation (decay anchor)
  ignoreUntilMs: number; // suppress bytes until this timestamp (avoids false heat on session switch)
  lastQuantizedHeat: number; // last quantized heat level for reduced-motion mode
}

const sessions = new Map<string, SessionHeat>();
let rafId = 0;
let reducedMotion = false;

// =============================================================================
// Color lookup
// =============================================================================

function lerpColor(t: number): [number, number, number] {
  const index = Math.min(COLOR_LUT_SIZE - 1, Math.max(0, Math.round(t * (COLOR_LUT_SIZE - 1))));
  return colorLUT[index] ?? [10, 14, 26];
}

// =============================================================================
// Canvas drawing
// =============================================================================

function drawCanvas(s: SessionHeat): void {
  const { ctx, heat } = s;

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
// Decay curve (LUT-backed)
// =============================================================================

function triExpDecay(seconds: number): number {
  const index = Math.round(seconds / DECAY_LUT_STEP);
  if (index < DECAY_LUT_SIZE) {
    return decayLUT[Math.max(0, index)] ?? 0;
  }
  // Beyond LUT range (>100s): compute directly — rare, only long-idle sessions
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
  let anyActive = false;

  for (const s of sessions.values()) {
    // Periodically recalculate byte rate and update heat
    const elapsed = nowMs - s.lastTickMs;
    if (elapsed >= RATE_INTERVAL_MS) {
      // Cap rate window to prevent dilution during rAF freezes (background tabs)
      const rateWindow = Math.min(elapsed, 2000);
      const rate = (s.byteAccum / rateWindow) * 1000; // bytes/sec
      s.byteAccum = 0;
      s.lastTickMs = nowMs;

      // Self-calibrate: peak tracks the max rate, decays with capped elapsed to prevent collapse
      const peakElapsedSec = Math.min(elapsed / 1000, 2);
      const peakDecay = Math.pow(0.5, peakElapsedSec / PEAK_HALF_LIFE_SEC);
      s.peakRate = Math.max(MIN_PEAK, Math.max(rate, s.peakRate * peakDecay));

      // Add heat proportional to current rate vs peak
      // MIN_RATE filters out noise from focus events, shell keep-alives, and tiny prompt redraws
      if (rate >= MIN_RATE) {
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

    if (!document.hidden) {
      if (reducedMotion) {
        // Quantize to 4 steps instead of smooth animation
        const q = s.heat < 0.165 ? 0 : s.heat < 0.495 ? 0.33 : s.heat < 0.83 ? 0.66 : 1.0;
        if (q !== s.lastQuantizedHeat) {
          s.lastQuantizedHeat = q;
          const saved = s.heat;
          s.heat = q;
          drawCanvas(s);
          s.heat = saved;
        }
      } else {
        drawCanvas(s);
      }
    }

    if (s.heat >= DRAW_THRESHOLD) {
      anyActive = true;
    }
  }

  if (anyActive) {
    rafId = requestAnimationFrame(drawFrame);
  } else {
    rafId = 0;
  }
}

function ensureLoopRunning(): void {
  if (!rafId && sessions.size > 0) {
    rafId = requestAnimationFrame(drawFrame);
  }
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

  const now = performance.now();
  sessions.set(sessionId, {
    canvas,
    ctx,
    heat: 0,
    lastDrawnHeat: 0,
    peakRate: MIN_PEAK,
    byteAccum: 0,
    lastTickMs: now,
    lastActiveMs: now,
    heatWhenInactive: 0,
    ignoreUntilMs: 0,
    lastQuantizedHeat: 0,
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
  ensureLoopRunning();
}

/**
 * Suppress heat recording for ALL sessions for a short duration.
 * Used when switching active sessions — the server flushes background
 * buffers which would falsely heat up idle sessions.
 */
export function suppressAllHeat(durationMs: number): void {
  const now = performance.now();
  const until = now + durationMs;
  sessions.forEach((s) => {
    s.ignoreUntilMs = until;
    s.byteAccum = 0;
    s.lastTickMs = now;
  });
}

/**
 * Start the shared animation loop for all heat indicators.
 */
export function initHeatIndicator(): void {
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  reducedMotion = mq.matches;
  mq.addEventListener('change', (e) => {
    reducedMotion = e.matches;
  });

  if (rafId) return;
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
