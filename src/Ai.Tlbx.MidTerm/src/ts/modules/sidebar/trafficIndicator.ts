/**
 * Traffic Indicator Module
 *
 * Displays WebSocket traffic rate in sidebar footer using SMA (Simple Moving Average).
 * Uses DIRECT DOM manipulation - no reactive stores for display value.
 * Completely isolated from sidebar rendering.
 */
import { resetWsAccum, setWsRateEma } from '../../state';
import { $muxWsConnected } from '../../stores';

const UPDATE_MS = 500;
const WINDOW_SIZE = 10; // 10 samples × 500ms = 5 second rolling window

let intervalId: number | null = null;
let el: HTMLSpanElement | null = null;
let lastText = '';

// Circular buffer for SMA
const txSamples: number[] = new Array(WINDOW_SIZE).fill(0);
const rxSamples: number[] = new Array(WINDOW_SIZE).fill(0);
let sampleIndex = 0;
let filledSamples = 0;

function formatRate(bps: number): string {
  if (bps < 1) return '0 B/s';
  if (bps < 1000) return Math.round(bps) + ' B/s';
  if (bps < 1000000) return (bps / 1000).toFixed(1) + ' KB/s';
  return (bps / 1000000).toFixed(2) + ' MB/s';
}

function tick(): void {
  const { tx, rx } = resetWsAccum();
  const txRate = (tx / UPDATE_MS) * 1000;
  const rxRate = (rx / UPDATE_MS) * 1000;

  // Store in circular buffer
  txSamples[sampleIndex] = txRate;
  rxSamples[sampleIndex] = rxRate;
  sampleIndex = (sampleIndex + 1) % WINDOW_SIZE;
  if (filledSamples < WINDOW_SIZE) filledSamples++;

  // Calculate SMA over filled samples
  let txSum = 0,
    rxSum = 0;
  for (let i = 0; i < filledSamples; i++) {
    txSum += txSamples[i]!;
    rxSum += rxSamples[i]!;
  }
  const txAvg = txSum / filledSamples;
  const rxAvg = rxSum / filledSamples;

  setWsRateEma(txAvg, rxAvg);

  const text = formatRate(txAvg + rxAvg);
  if (text !== lastText && el) {
    el.textContent = text;
    lastText = text;
  }
}

export function initTrafficIndicator(): void {
  el = document.getElementById('ws-traffic') as HTMLSpanElement;
  if (!el) return;

  intervalId = window.setInterval(tick, UPDATE_MS);

  $muxWsConnected.subscribe((connected) => {
    if (el) el.style.opacity = connected ? '1' : '0.3';
    if (!connected) {
      // Reset circular buffer and state
      txSamples.fill(0);
      rxSamples.fill(0);
      sampleIndex = 0;
      filledSamples = 0;
      setWsRateEma(0, 0);
      lastText = '';
    }
  });
}

export function destroyTrafficIndicator(): void {
  if (intervalId) clearInterval(intervalId);
  intervalId = null;
}
