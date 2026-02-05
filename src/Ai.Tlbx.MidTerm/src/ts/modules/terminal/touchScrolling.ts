/**
 * Touch Scrolling Module
 *
 * Fixes mobile touch behavior on xterm.js terminals.
 * Default: single-finger drag scrolls the terminal viewport.
 * Long-press (500ms): switches to xterm text selection mode.
 * Quick tap: focuses terminal / sends mouse click for TUI interaction.
 *
 * Uses a transparent overlay to intercept touches before xterm.js,
 * while still allowing events to bubble to parent gesture handlers.
 */

import type { Terminal } from '@xterm/xterm';
import { isTouchDevice, hasPrecisePointer } from '../touchController/detection';

const LONG_PRESS_MS = 500;
const MOVE_THRESHOLD = 10;
const TAP_MAX_DURATION = 300;
const MOMENTUM_FRICTION = 0.95;
const MOMENTUM_MIN_VELOCITY = 0.5;

type TouchMode = 'idle' | 'pending' | 'scrolling' | 'selecting';

interface TouchScrollState {
  overlay: HTMLDivElement;
  viewport: HTMLElement;
  screen: HTMLElement;
  terminal: Terminal;
  mode: TouchMode;
  longPressTimer: number | null;
  startX: number;
  startY: number;
  lastY: number;
  startTime: number;
  velocity: number;
  lastMoveTime: number;
  momentumRaf: number | null;
  handlers: {
    touchstart: (e: TouchEvent) => void;
    touchmove: (e: TouchEvent) => void;
    touchend: (e: TouchEvent) => void;
    touchcancel: (e: TouchEvent) => void;
  };
  documentTouchEnd: ((e: TouchEvent) => void) | null;
}

const states = new Map<string, TouchScrollState>();

export function initTouchScrolling(
  sessionId: string,
  terminal: Terminal,
  container: HTMLDivElement,
): void {
  if (!isTouchDevice() || hasPrecisePointer()) return;

  const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
  const screen = container.querySelector('.xterm-screen') as HTMLElement | null;
  if (!viewport || !screen) return;

  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position: absolute;
    inset: 0;
    z-index: 1;
    touch-action: none;
    background: transparent;
  `;
  container.appendChild(overlay);

  const touchState: TouchScrollState = {
    overlay,
    viewport,
    screen,
    terminal,
    mode: 'idle',
    longPressTimer: null,
    startX: 0,
    startY: 0,
    lastY: 0,
    startTime: 0,
    velocity: 0,
    lastMoveTime: 0,
    momentumRaf: null,
    handlers: {
      touchstart: (e) => handleTouchStart(sessionId, e),
      touchmove: (e) => handleTouchMove(sessionId, e),
      touchend: (e) => handleTouchEnd(sessionId, e),
      touchcancel: (e) => handleTouchCancel(sessionId, e),
    },
    documentTouchEnd: null,
  };

  overlay.addEventListener('touchstart', touchState.handlers.touchstart, { passive: false });
  overlay.addEventListener('touchmove', touchState.handlers.touchmove, { passive: false });
  overlay.addEventListener('touchend', touchState.handlers.touchend, { passive: false });
  overlay.addEventListener('touchcancel', touchState.handlers.touchcancel, { passive: true });

  states.set(sessionId, touchState);
}

export function teardownTouchScrolling(sessionId: string): void {
  const s = states.get(sessionId);
  if (!s) return;

  cancelLongPress(s);
  cancelMomentum(s);
  removeDocumentListener(s);

  s.overlay.removeEventListener('touchstart', s.handlers.touchstart);
  s.overlay.removeEventListener('touchmove', s.handlers.touchmove);
  s.overlay.removeEventListener('touchend', s.handlers.touchend);
  s.overlay.removeEventListener('touchcancel', s.handlers.touchcancel);
  s.overlay.remove();

  states.delete(sessionId);
}

export function isTouchSelecting(sessionId: string): boolean {
  const s = states.get(sessionId);
  return s?.mode === 'selecting';
}

function handleTouchStart(sessionId: string, e: TouchEvent): void {
  const s = states.get(sessionId);
  if (!s) return;

  // Only handle single-finger touches; multi-touch goes to gesture system
  if (e.touches.length !== 1) return;

  const touch = e.touches[0]!;

  cancelMomentum(s);

  s.mode = 'pending';
  s.startX = touch.clientX;
  s.startY = touch.clientY;
  s.lastY = touch.clientY;
  s.startTime = Date.now();
  s.velocity = 0;
  s.lastMoveTime = Date.now();

  s.longPressTimer = window.setTimeout(() => {
    enterSelectionMode(s, touch.clientX, touch.clientY);
  }, LONG_PRESS_MS);
}

function handleTouchMove(sessionId: string, e: TouchEvent): void {
  const s = states.get(sessionId);
  if (!s || e.touches.length !== 1) return;

  const touch = e.touches[0]!;
  const dx = touch.clientX - s.startX;
  const dy = touch.clientY - s.startY;

  if (s.mode === 'pending') {
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    if (absDy > MOVE_THRESHOLD) {
      // Vertical movement dominant — enter scroll mode
      cancelLongPress(s);
      s.mode = 'scrolling';
      e.preventDefault();
    } else if (absDx > MOVE_THRESHOLD && absDx > absDy * 1.5) {
      // Horizontal movement dominant — stay pending, let gesture system handle swipe
      cancelLongPress(s);
      s.mode = 'idle';
      return;
    }
  }

  if (s.mode === 'scrolling') {
    e.preventDefault();
    const deltaY = s.lastY - touch.clientY;
    const now = Date.now();
    const dt = now - s.lastMoveTime;

    if (dt > 0) {
      s.velocity = (deltaY / dt) * 16;
    }

    s.lastY = touch.clientY;
    s.lastMoveTime = now;
    scrollViewport(s, deltaY);
  }
}

function handleTouchEnd(sessionId: string, e: TouchEvent): void {
  const s = states.get(sessionId);
  if (!s) return;

  const mode = s.mode;
  cancelLongPress(s);

  if (mode === 'pending') {
    // Quick tap — focus terminal and dispatch click for TUI support
    const touch = e.changedTouches[0];
    if (touch) {
      const duration = Date.now() - s.startTime;
      if (duration < TAP_MAX_DURATION) {
        e.preventDefault();
        s.terminal.focus();
        dispatchSyntheticClick(s, touch.clientX, touch.clientY);
      }
    }
    s.mode = 'idle';
  } else if (mode === 'scrolling') {
    e.preventDefault();
    startMomentum(s);
    s.mode = 'idle';
  }
  // 'selecting' mode is handled by the document touchend listener
}

function handleTouchCancel(sessionId: string, _e: TouchEvent): void {
  const s = states.get(sessionId);
  if (!s) return;
  cancelLongPress(s);
  s.mode = 'idle';
}

function enterSelectionMode(s: TouchScrollState, clientX: number, clientY: number): void {
  s.mode = 'selecting';
  s.longPressTimer = null;

  // Haptic feedback
  navigator.vibrate?.(30);

  // Hide overlay so touches reach xterm for selection
  s.overlay.style.pointerEvents = 'none';

  // Dispatch synthetic mousedown to xterm screen to start selection
  const mousedown = new MouseEvent('mousedown', {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
    button: 0,
  });
  s.screen.dispatchEvent(mousedown);

  // Re-enable overlay when the selection gesture ends
  const onDocumentTouchEnd = (): void => {
    s.overlay.style.pointerEvents = '';
    s.mode = 'idle';
    s.documentTouchEnd = null;
  };
  s.documentTouchEnd = onDocumentTouchEnd;
  document.addEventListener('touchend', onDocumentTouchEnd, { once: true, capture: true });
}

function scrollViewport(s: TouchScrollState, deltaY: number): void {
  const max = s.viewport.scrollHeight - s.viewport.clientHeight;
  s.viewport.scrollTop = Math.max(0, Math.min(max, s.viewport.scrollTop + deltaY));
}

function startMomentum(s: TouchScrollState): void {
  if (Math.abs(s.velocity) < MOMENTUM_MIN_VELOCITY) return;

  let v = s.velocity;

  const step = (): void => {
    v *= MOMENTUM_FRICTION;
    if (Math.abs(v) < MOMENTUM_MIN_VELOCITY) {
      s.momentumRaf = null;
      return;
    }
    scrollViewport(s, v);
    s.momentumRaf = requestAnimationFrame(step);
  };

  s.momentumRaf = requestAnimationFrame(step);
}

function cancelLongPress(s: TouchScrollState): void {
  if (s.longPressTimer !== null) {
    window.clearTimeout(s.longPressTimer);
    s.longPressTimer = null;
  }
}

function cancelMomentum(s: TouchScrollState): void {
  if (s.momentumRaf !== null) {
    cancelAnimationFrame(s.momentumRaf);
    s.momentumRaf = null;
  }
}

function removeDocumentListener(s: TouchScrollState): void {
  if (s.documentTouchEnd) {
    document.removeEventListener('touchend', s.documentTouchEnd, { capture: true });
    s.documentTouchEnd = null;
  }
}

function dispatchSyntheticClick(s: TouchScrollState, clientX: number, clientY: number): void {
  const opts: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
    button: 0,
  };

  // Briefly let events through to xterm
  s.overlay.style.pointerEvents = 'none';
  s.screen.dispatchEvent(new MouseEvent('mousedown', opts));
  s.screen.dispatchEvent(new MouseEvent('mouseup', opts));
  // Restore overlay after a microtask so xterm processes the events
  queueMicrotask(() => {
    s.overlay.style.pointerEvents = '';
  });
}
