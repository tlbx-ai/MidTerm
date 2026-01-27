/**
 * Dock Overlay Module
 *
 * Displays visual drop zones when dragging sessions to create layouts.
 * Shows top/bottom/left/right zones on the target terminal pane.
 */

import type { DockPosition } from '../../types';
import { isLayoutActive } from './layoutStore';
import { findSessionAtPoint, getSessionPaneRect } from './layoutRenderer';
import { $activeSessionId } from '../../stores';

let overlayElement: HTMLElement | null = null;
let currentTargetSessionId: string | null = null;
let currentHighlightedZone: DockPosition | null = null;

/**
 * Create the dock overlay element structure.
 */
function createOverlayElement(): HTMLElement {
  const overlay = document.createElement('div');
  overlay.className = 'dock-overlay hidden';

  const zones: DockPosition[] = ['top', 'bottom', 'left', 'right'];
  for (const zone of zones) {
    const zoneEl = document.createElement('div');
    zoneEl.className = `dock-zone ${zone}`;
    zoneEl.dataset.position = zone;
    overlay.appendChild(zoneEl);
  }

  // Center zone indicator (shows which session is being targeted)
  const centerEl = document.createElement('div');
  centerEl.className = 'dock-center';
  overlay.appendChild(centerEl);

  return overlay;
}

/**
 * Initialize the dock overlay.
 */
export function initDockOverlay(): void {
  if (overlayElement) return;

  overlayElement = createOverlayElement();
  document.body.appendChild(overlayElement);
}

/**
 * Show the dock overlay at the given position.
 * Called during drag over terminals area.
 */
export function showDockOverlay(x: number, y: number, draggedSessionId: string): void {
  if (!overlayElement) {
    initDockOverlay();
  }
  if (!overlayElement) return;

  // Find target session at point
  let targetSessionId: string | null = null;

  if (isLayoutActive()) {
    targetSessionId = findSessionAtPoint(x, y);
  } else {
    // Standalone mode - target the active session
    targetSessionId = $activeSessionId.get();
  }

  // Don't show overlay if dragging over self or no target
  if (!targetSessionId || targetSessionId === draggedSessionId) {
    hideDockOverlay();
    return;
  }

  // Get target pane rect
  const rect = getSessionPaneRect(targetSessionId);
  if (!rect) {
    hideDockOverlay();
    return;
  }

  // Position overlay over target pane
  overlayElement.style.left = `${rect.left}px`;
  overlayElement.style.top = `${rect.top}px`;
  overlayElement.style.width = `${rect.width}px`;
  overlayElement.style.height = `${rect.height}px`;
  overlayElement.classList.remove('hidden');

  currentTargetSessionId = targetSessionId;

  // Highlight zone based on cursor position
  highlightZone(x, y, rect);
}

/**
 * Highlight the appropriate dock zone based on cursor position.
 */
function highlightZone(x: number, y: number, rect: DOMRect): void {
  if (!overlayElement) return;

  // Calculate relative position within pane
  const relX = (x - rect.left) / rect.width;
  const relY = (y - rect.top) / rect.height;

  // Determine which zone the cursor is in
  // Edge zones are 25% of width/height
  const edgeThreshold = 0.25;

  let zone: DockPosition | null = null;

  if (relY < edgeThreshold) {
    zone = 'top';
  } else if (relY > 1 - edgeThreshold) {
    zone = 'bottom';
  } else if (relX < edgeThreshold) {
    zone = 'left';
  } else if (relX > 1 - edgeThreshold) {
    zone = 'right';
  }

  // Update highlighted zone
  if (zone !== currentHighlightedZone) {
    currentHighlightedZone = zone;

    // Remove highlight from all zones
    const zones = overlayElement.querySelectorAll('.dock-zone');
    zones.forEach((z) => z.classList.remove('highlighted'));

    // Add highlight to current zone
    if (zone) {
      const zoneEl = overlayElement.querySelector(`.dock-zone.${zone}`);
      zoneEl?.classList.add('highlighted');
    }
  }
}

/**
 * Hide the dock overlay.
 */
export function hideDockOverlay(): void {
  if (!overlayElement) return;

  overlayElement.classList.add('hidden');
  currentTargetSessionId = null;
  currentHighlightedZone = null;

  // Remove all highlights
  const zones = overlayElement.querySelectorAll('.dock-zone');
  zones.forEach((z) => z.classList.remove('highlighted'));
}

/**
 * Get the current dock target and position.
 * Returns null if no valid drop zone is highlighted.
 */
export function getDockTarget(): { targetSessionId: string; position: DockPosition } | null {
  if (!currentTargetSessionId || !currentHighlightedZone) {
    return null;
  }

  return {
    targetSessionId: currentTargetSessionId,
    position: currentHighlightedZone,
  };
}

/**
 * Check if the dock overlay is currently visible.
 */
export function isDockOverlayVisible(): boolean {
  return overlayElement !== null && !overlayElement.classList.contains('hidden');
}

/**
 * Clean up dock overlay.
 */
export function cleanupDockOverlay(): void {
  if (overlayElement) {
    overlayElement.remove();
    overlayElement = null;
  }
  currentTargetSessionId = null;
  currentHighlightedZone = null;
}
