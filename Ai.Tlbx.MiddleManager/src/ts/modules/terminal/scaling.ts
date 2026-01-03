/**
 * Terminal Scaling Module
 *
 * Handles terminal scaling, fitting to screen, and viewport resize handling.
 * Terminals maintain server-side dimensions and are scaled to fit the viewport.
 */

import type { TerminalState } from '../../types';
import {
  sessionTerminals,
  fontsReadyPromise,
  dom
} from '../../state';
import { debounce } from '../../utils';

// Forward declarations for functions from other modules
let sendResize: (sessionId: string, terminal: any) => void = () => {};

/**
 * Register callbacks from other modules
 */
export function registerScalingCallbacks(callbacks: {
  sendResize?: (sessionId: string, terminal: any) => void;
}): void {
  if (callbacks.sendResize) sendResize = callbacks.sendResize;
}

/**
 * Fit a session's terminal to the current screen size.
 * This sends a resize request to the server.
 */
export function fitSessionToScreen(sessionId: string): void {
  const state = sessionTerminals.get(sessionId);
  if (!state) return;

  // Wait for terminal to be opened before fitting
  if (!state.opened) {
    (fontsReadyPromise ?? Promise.resolve()).then(() => {
      fitSessionToScreen(sessionId);
    });
    return;
  }

  // Clear any existing scaling first
  const xterm = state.container.querySelector('.xterm') as HTMLElement | null;
  if (xterm) {
    (xterm.style as any).zoom = '';
    xterm.style.transform = '';
    state.container.classList.remove('scaled');
  }

  // Ensure terminal is visible for accurate measurement
  const wasHidden = state.container.classList.contains('hidden');
  if (wasHidden) {
    state.container.classList.remove('hidden');
  }

  requestAnimationFrame(() => {
    state.fitAddon.fit();
    sendResize(sessionId, state.terminal);

    if (wasHidden) {
      state.container.classList.add('hidden');
    }
  });
}

/**
 * Apply CSS scaling to a terminal to fit within its container.
 * Scales down terminals that are larger than the available space.
 * Uses CSS zoom instead of transform:scale for better pixel alignment.
 */
export function applyTerminalScaling(sessionId: string, state: TerminalState): void {
  const container = state.container;
  const xterm = container.querySelector('.xterm') as HTMLElement | null;
  if (!xterm) return;

  // Use requestAnimationFrame for accurate measurements after resize
  requestAnimationFrame(() => {
    const availWidth = container.clientWidth - 8;
    const availHeight = container.clientHeight - 8;
    const termWidth = xterm.offsetWidth;
    const termHeight = xterm.offsetHeight;

    // Calculate scale (shrink only, never enlarge)
    const scaleX = availWidth / termWidth;
    const scaleY = availHeight / termHeight;
    const scale = Math.min(scaleX, scaleY, 1);

    if (scale < 0.99) {
      // Use zoom instead of transform:scale for better pixel alignment
      // zoom respects pixel boundaries, transform can cause subpixel rendering
      (xterm.style as any).zoom = scale;
      xterm.style.transform = '';
      container.classList.add('scaled');
    } else {
      (xterm.style as any).zoom = '';
      xterm.style.transform = '';
      container.classList.remove('scaled');
    }
  });
}

/**
 * Set up resize observer to recalculate scaling when window resizes
 */
export function setupResizeObserver(): void {
  window.addEventListener('resize', debounce(() => {
    sessionTerminals.forEach((state, sessionId) => {
      if (state.opened) {
        applyTerminalScaling(sessionId, state);
      }
    });
  }, 100));
}

/**
 * Set up visual viewport handling for mobile keyboard appearance.
 * Updates viewport height CSS variable when visual viewport changes.
 */
export function setupVisualViewport(): void {
  if (!window.visualViewport || !dom.terminalsArea) return;

  let lastHeight = 0;

  const updateViewportHeight = () => {
    const vh = window.visualViewport!.height;
    if (Math.abs(vh - lastHeight) < 1) return;
    lastHeight = vh;

    document.documentElement.style.setProperty('--visual-vh', vh + 'px');

    const mobileHeader = document.querySelector('.mobile-header') as HTMLElement | null;
    let headerHeight = 0;
    if (mobileHeader && window.getComputedStyle(mobileHeader).display !== 'none') {
      headerHeight = mobileHeader.offsetHeight;
    }

    const availableHeight = Math.floor((vh - headerHeight) * 0.99);
    dom.terminalsArea!.style.height = availableHeight + 'px';
  };

  window.visualViewport.addEventListener('resize', updateViewportHeight);
  updateViewportHeight();
}
