/**
 * Latency Overlay Module
 *
 * Floating overlay on the terminal showing real-time input→output RTT.
 * Toggled via Settings > Diagnostics.
 */

import { onOutputRtt, offOutputRtt } from '../comms/muxChannel';
import { $activeSessionId } from '../../stores';
import { sessionTerminals } from '../../state';

let overlayEl: HTMLDivElement | null = null;
let enabled = false;
let currentSessionId: string | null = null;
let unsubscribeSession: (() => void) | null = null;

export function enableLatencyOverlay(): void {
  if (enabled) return;
  enabled = true;
  onOutputRtt(handleOutputRtt);
  ensureOverlay();
  attachToActiveSession();
  unsubscribeSession = $activeSessionId.subscribe(() => {
    attachToActiveSession();
  });
}

export function disableLatencyOverlay(): void {
  if (!enabled) return;
  enabled = false;
  offOutputRtt(handleOutputRtt);
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
  overlayEl.textContent = '— ms';
}

function removeOverlay(): void {
  if (overlayEl) {
    overlayEl.remove();
    overlayEl = null;
  }
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

function handleOutputRtt(sessionId: string, rtt: number): void {
  if (!overlayEl || !enabled) return;

  const activeId = $activeSessionId.get();
  if (sessionId !== activeId) return;

  if (currentSessionId !== sessionId) {
    attachToActiveSession();
  }

  const rounded = rtt.toFixed(1);
  overlayEl.textContent = `${rounded} ms`;

  overlayEl.classList.remove('latency-good', 'latency-warn', 'latency-bad');
  if (rtt < 30) {
    overlayEl.classList.add('latency-good');
  } else if (rtt < 100) {
    overlayEl.classList.add('latency-warn');
  } else {
    overlayEl.classList.add('latency-bad');
  }
}
