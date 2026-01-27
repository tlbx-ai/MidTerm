/**
 * Layout Renderer Module
 *
 * Recursively renders the layout tree to DOM elements.
 * Handles terminal container placement within layout panes.
 */

import type { LayoutNode, LayoutSplit, LayoutLeaf } from '../../types';
import { $layout, $focusedSessionId, $activeSessionId } from '../../stores';
import { dom, sessionTerminals } from '../../state';
import { isLayoutActive, focusLayoutSession } from './layoutStore';
import { applyTerminalScalingSync, fitTerminalToContainer } from '../terminal/scaling';

let layoutRoot: HTMLElement | null = null;
let unsubscribeLayout: (() => void) | null = null;
let unsubscribeFocus: (() => void) | null = null;

/**
 * Initialize the layout renderer.
 * Sets up subscriptions to layout state changes.
 */
export function initLayoutRenderer(): void {
  // Create layout root container
  if (!layoutRoot && dom.terminalsArea) {
    layoutRoot = document.createElement('div');
    layoutRoot.className = 'layout-root hidden';
    dom.terminalsArea.appendChild(layoutRoot);
  }

  // Subscribe to layout changes
  unsubscribeLayout = $layout.subscribe((layout) => {
    renderLayout(layout.root);
  });

  // Subscribe to focus changes
  unsubscribeFocus = $focusedSessionId.subscribe((focusedId) => {
    updateFocusIndicator(focusedId);
  });
}

/**
 * Clean up layout renderer subscriptions.
 */
export function cleanupLayoutRenderer(): void {
  if (unsubscribeLayout) {
    unsubscribeLayout();
    unsubscribeLayout = null;
  }
  if (unsubscribeFocus) {
    unsubscribeFocus();
    unsubscribeFocus = null;
  }
}

/**
 * Render the layout tree to DOM.
 * Shows standalone terminal or layout root based on state.
 */
export function renderLayout(root: LayoutNode | null): void {
  if (!layoutRoot) return;

  // Clear existing layout DOM
  layoutRoot.innerHTML = '';

  if (!root) {
    // No layout - hide layout root, show standalone terminals
    layoutRoot.classList.add('hidden');
    showStandaloneTerminals();

    // Show the active standalone session
    const activeId = $activeSessionId.get();
    if (activeId) {
      const state = sessionTerminals.get(activeId);
      if (state) {
        state.container.classList.remove('hidden');
        requestAnimationFrame(() => {
          applyTerminalScalingSync(state);
          if (state.terminal && state.opened) {
            state.terminal.focus();
          }
        });
      }
    }
    return;
  }

  // Layout active - build DOM tree
  layoutRoot.classList.remove('hidden');
  hideStandaloneTerminals();

  const rootElement = renderNode(root);
  if (rootElement) {
    layoutRoot.appendChild(rootElement);
  }

  // Move terminal containers into their layout panes
  moveTerminalsToLayout();

  // Trigger resize for all terminals in layout
  requestAnimationFrame(() => {
    fitTerminalsInLayout();
  });
}

/**
 * Recursively render a layout node to DOM.
 */
function renderNode(node: LayoutNode): HTMLElement | null {
  if (node.type === 'leaf') {
    return renderLeaf(node);
  }
  return renderSplit(node);
}

/**
 * Render a leaf node (terminal pane).
 */
function renderLeaf(leaf: LayoutLeaf): HTMLElement {
  const pane = document.createElement('div');
  pane.className = 'layout-leaf';
  pane.dataset.sessionId = leaf.sessionId;

  // Add click handler for focus
  pane.addEventListener('click', () => {
    focusLayoutSession(leaf.sessionId);
  });

  return pane;
}

/**
 * Render a split node (flex container).
 */
function renderSplit(split: LayoutSplit): HTMLElement {
  const container = document.createElement('div');
  container.className = `layout-split ${split.direction}`;

  for (const child of split.children) {
    const childElement = renderNode(child);
    if (childElement) {
      container.appendChild(childElement);
    }
  }

  return container;
}

/**
 * Move terminal containers from terminals-area into their layout panes.
 */
function moveTerminalsToLayout(): void {
  if (!layoutRoot) return;

  const panes = layoutRoot.querySelectorAll('.layout-leaf');
  panes.forEach((pane) => {
    const sessionId = (pane as HTMLElement).dataset.sessionId;
    if (!sessionId) return;

    const state = sessionTerminals.get(sessionId);
    if (state) {
      // Move container into pane
      pane.appendChild(state.container);
      state.container.classList.remove('hidden');
    }
  });
}

/**
 * Show standalone terminals (when layout is inactive).
 */
function showStandaloneTerminals(): void {
  if (!dom.terminalsArea) return;

  // Move any terminals back to terminals-area from layout panes
  sessionTerminals.forEach((state) => {
    if (state.container.parentElement !== dom.terminalsArea) {
      dom.terminalsArea!.appendChild(state.container);
    }
  });
}

/**
 * Hide standalone terminals (layout is active).
 */
function hideStandaloneTerminals(): void {
  sessionTerminals.forEach((state) => {
    state.container.classList.add('hidden');
  });
}

/**
 * Fit all terminals in the layout to their pane sizes.
 * Resizes terminals (cols/rows) to fit panes and notifies server.
 */
function fitTerminalsInLayout(): void {
  if (!layoutRoot) return;

  const panes = layoutRoot.querySelectorAll('.layout-leaf');
  panes.forEach((pane) => {
    const paneEl = pane as HTMLElement;
    const sessionId = paneEl.dataset.sessionId;
    if (!sessionId) return;

    const state = sessionTerminals.get(sessionId);
    if (state?.opened) {
      // Resize terminal to fit pane dimensions
      fitTerminalToContainer(sessionId, paneEl);
    }
  });
}

/**
 * Update focus indicator on layout panes.
 */
function updateFocusIndicator(focusedId: string | null): void {
  if (!layoutRoot) return;

  // Remove focused class from all panes
  const panes = layoutRoot.querySelectorAll('.layout-leaf');
  panes.forEach((pane) => {
    pane.classList.remove('focused');
    const sessionId = (pane as HTMLElement).dataset.sessionId;
    if (sessionId === focusedId) {
      pane.classList.add('focused');

      // Focus the terminal
      const state = sessionTerminals.get(sessionId);
      if (state?.terminal && state.opened) {
        state.terminal.focus();
      }
    }
  });
}

/**
 * Get the layout root element.
 */
export function getLayoutRoot(): HTMLElement | null {
  return layoutRoot;
}

/**
 * Check if a point is within the layout area.
 */
export function isPointInLayoutArea(x: number, y: number): boolean {
  if (!dom.terminalsArea) return false;
  const rect = dom.terminalsArea.getBoundingClientRect();
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

/**
 * Find the session ID at a point in the layout.
 * Returns null if no session found or layout not active.
 */
export function findSessionAtPoint(x: number, y: number): string | null {
  if (!layoutRoot || !isLayoutActive()) {
    // Check standalone terminal
    if (dom.terminalsArea) {
      const container = dom.terminalsArea.querySelector('.terminal-container:not(.hidden)');
      if (container) {
        const rect = container.getBoundingClientRect();
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
          const id = container.id.replace('terminal-', '');
          return id || null;
        }
      }
    }
    return null;
  }

  // Find pane at point
  const panes = layoutRoot.querySelectorAll('.layout-leaf');
  for (const pane of panes) {
    const rect = pane.getBoundingClientRect();
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
      return (pane as HTMLElement).dataset.sessionId ?? null;
    }
  }

  return null;
}

/**
 * Get the bounding rect for a session's pane in the layout.
 */
export function getSessionPaneRect(sessionId: string): DOMRect | null {
  if (!layoutRoot || !isLayoutActive()) {
    // Standalone terminal
    const container = document.getElementById(`terminal-${sessionId}`);
    return container?.getBoundingClientRect() ?? null;
  }

  const pane = layoutRoot.querySelector(`.layout-leaf[data-session-id="${sessionId}"]`);
  return pane?.getBoundingClientRect() ?? null;
}
