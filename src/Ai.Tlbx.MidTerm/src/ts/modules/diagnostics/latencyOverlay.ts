/**
 * Latency Overlay Module
 *
 * Floating overlay on the terminal showing real-time diagnostics:
 * output RTT, server ping, mthost ping, flush delay, and scrollback buffer fill.
 * Toggled via Settings > Diagnostics.
 */

import {
  onOutputRtt,
  offOutputRtt,
  measureLatency,
  getLastFlushDelay,
  getLastServerIoRtt,
} from '../comms/muxChannel';
import { $activeSessionId } from '../../stores';
import { sessionTerminals } from '../../state';

let overlayEl: HTMLDivElement | null = null;
let enabled = false;
let currentSessionId: string | null = null;
let unsubscribeSession: (() => void) | null = null;
let pingInterval: ReturnType<typeof setInterval> | null = null;

interface MetricElements {
  outputRtt: HTMLSpanElement;
  serverRtt: HTMLSpanElement;
  mthostRtt: HTMLSpanElement;
  serverIo: HTMLSpanElement;
  flushDelay: HTMLSpanElement;
  scrollback: HTMLSpanElement;
}

let metricEls: MetricElements | null = null;

export function enableLatencyOverlay(): void {
  if (enabled) return;
  enabled = true;
  onOutputRtt(handleOutputRtt);
  ensureOverlay();
  attachToActiveSession();
  startPingLoop();
  unsubscribeSession = $activeSessionId.subscribe(() => {
    attachToActiveSession();
    runPingAndScrollback();
  });
}

export function disableLatencyOverlay(): void {
  if (!enabled) return;
  enabled = false;
  offOutputRtt(handleOutputRtt);
  stopPingLoop();
  removeOverlay();
  if (unsubscribeSession) {
    unsubscribeSession();
    unsubscribeSession = null;
  }
}

export function isLatencyOverlayEnabled(): boolean {
  return enabled;
}

export function reattachOverlay(): void {
  if (!enabled) return;
  attachToActiveSession();
}

function ensureOverlay(): void {
  if (overlayEl) return;
  overlayEl = document.createElement('div');
  overlayEl.className = 'latency-overlay';

  const rows = [
    { label: 'Out', id: 'outputRtt' },
    { label: 'Srv', id: 'serverRtt' },
    { label: 'Host', id: 'mthostRtt' },
    { label: 'I/O', id: 'serverIo' },
    { label: 'Flush', id: 'flushDelay' },
    { label: 'Buf', id: 'scrollback' },
  ] as const;

  const els: Partial<MetricElements> = {};
  for (const row of rows) {
    const line = document.createElement('div');
    line.className = 'latency-overlay-row';
    const label = document.createElement('span');
    label.className = 'latency-overlay-label';
    label.textContent = row.label;
    const value = document.createElement('span');
    value.className = 'latency-overlay-value';
    value.textContent = '—';
    line.appendChild(label);
    line.appendChild(value);
    overlayEl.appendChild(line);
    els[row.id] = value;
  }
  metricEls = els as MetricElements;
}

function removeOverlay(): void {
  if (overlayEl) {
    overlayEl.remove();
    overlayEl = null;
  }
  metricEls = null;
  currentSessionId = null;
}

function attachToActiveSession(): void {
  if (!overlayEl) return;
  const sessionId = $activeSessionId.get();
  if (!sessionId) return;

  if (currentSessionId === sessionId && overlayEl.parentElement) return;

  const state = sessionTerminals.get(sessionId);
  if (!state) return;

  overlayEl.remove();
  state.container.appendChild(overlayEl);
  currentSessionId = sessionId;
}

function startPingLoop(): void {
  stopPingLoop();
  runPingAndScrollback();
  pingInterval = setInterval(runPingAndScrollback, 3000);
}

function stopPingLoop(): void {
  if (pingInterval !== null) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
}

async function runPingAndScrollback(): Promise<void> {
  if (!enabled || !metricEls) return;
  const sessionId = $activeSessionId.get();
  if (!sessionId) return;

  updateScrollback(sessionId);

  const result = await measureLatency(sessionId);
  if (!metricEls) return;

  if (result.serverRtt !== null) {
    setMetric(metricEls.serverRtt, result.serverRtt);
  }
  if (result.mthostRtt !== null) {
    setMetric(metricEls.mthostRtt, result.mthostRtt);
  }

  const flushDelay = getLastFlushDelay();
  if (flushDelay !== null) {
    metricEls.flushDelay.textContent = `${flushDelay} ms`;
    applyColor(metricEls.flushDelay, flushDelay < 5 ? 'good' : flushDelay < 50 ? 'warn' : 'bad');
  }

  const serverIo = getLastServerIoRtt();
  if (serverIo !== null && serverIo >= 0) {
    metricEls.serverIo.textContent = `${serverIo} ms`;
    applyColor(metricEls.serverIo, serverIo < 30 ? 'good' : serverIo < 100 ? 'warn' : 'bad');
  }
}

function updateScrollback(sessionId: string): void {
  if (!metricEls) return;
  const state = sessionTerminals.get(sessionId);
  if (!state?.terminal) return;

  const used = state.terminal.buffer.active.length;
  const max = (state.terminal.options.scrollback ?? 10000) + state.terminal.rows;
  const pct = Math.round((used / max) * 100);
  metricEls.scrollback.textContent = `${used}/${max} (${pct}%)`;
  applyColor(metricEls.scrollback, pct < 50 ? 'good' : pct < 80 ? 'warn' : 'bad');
}

function handleOutputRtt(sessionId: string, rtt: number): void {
  if (!metricEls || !enabled) return;

  const activeId = $activeSessionId.get();
  if (sessionId !== activeId) return;

  if (currentSessionId !== sessionId) {
    attachToActiveSession();
  }

  setMetric(metricEls.outputRtt, rtt);
}

function setMetric(el: HTMLSpanElement, ms: number): void {
  el.textContent = `${ms.toFixed(1)} ms`;
  applyColor(el, ms < 30 ? 'good' : ms < 100 ? 'warn' : 'bad');
}

function applyColor(el: HTMLSpanElement, level: 'good' | 'warn' | 'bad'): void {
  el.classList.remove('latency-good', 'latency-warn', 'latency-bad');
  el.classList.add(`latency-${level}`);
}
