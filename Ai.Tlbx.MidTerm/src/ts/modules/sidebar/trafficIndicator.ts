/**
 * Traffic Indicator Module
 *
 * Displays WebSocket traffic rate in sidebar footer using EMA smoothing.
 * Uses DIRECT DOM manipulation - no reactive stores for display value.
 * Completely isolated from sidebar rendering.
 */
import { resetWsAccum, wsTxRateEma, wsRxRateEma, setWsRateEma } from '../../state';
import { $muxWsConnected } from '../../stores';

const UPDATE_MS = 500;
const EMA_ALPHA = 0.3;

let intervalId: number | null = null;
let el: HTMLSpanElement | null = null;
let lastText = '';

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

  const newTxEma = EMA_ALPHA * txRate + (1 - EMA_ALPHA) * wsTxRateEma;
  const newRxEma = EMA_ALPHA * rxRate + (1 - EMA_ALPHA) * wsRxRateEma;
  setWsRateEma(newTxEma, newRxEma);

  const text = formatRate(newTxEma + newRxEma);
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
      setWsRateEma(0, 0);
      lastText = '';
    }
  });
}

export function destroyTrafficIndicator(): void {
  if (intervalId) clearInterval(intervalId);
  intervalId = null;
}
