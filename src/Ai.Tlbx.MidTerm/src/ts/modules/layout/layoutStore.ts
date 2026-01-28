/**
 * Layout Store Module
 *
 * Manages the layout tree state and provides operations for
 * docking/undocking sessions in the multi-panel layout.
 */

import type { LayoutNode, LayoutLeaf, LayoutDirection, DockPosition, Session } from '../../types';
import { $layout, $focusedSessionId, $activeSessionId, getSession } from '../../stores';
import { sessionTerminals } from '../../state';

// Forward declarations - will be set by main.ts
let createTerminalForSessionFn:
  | ((sessionId: string, sessionInfo: Session | undefined) => void)
  | null = null;
let sendActiveSessionHintFn: ((sessionId: string | null) => void) | null = null;

/**
 * Register callbacks from main module.
 */
export function registerLayoutCallbacks(callbacks: {
  createTerminalForSession?: (sessionId: string, sessionInfo: Session | undefined) => void;
  sendActiveSessionHint?: (sessionId: string | null) => void;
}): void {
  if (callbacks.createTerminalForSession) {
    createTerminalForSessionFn = callbacks.createTerminalForSession;
  }
  if (callbacks.sendActiveSessionHint) {
    sendActiveSessionHintFn = callbacks.sendActiveSessionHint;
  }
}

/**
 * Ensure a terminal exists for a session.
 */
function ensureTerminalExists(sessionId: string): void {
  if (!sessionTerminals.has(sessionId) && createTerminalForSessionFn) {
    const sessionInfo = getSession(sessionId);
    createTerminalForSessionFn(sessionId, sessionInfo);
  }
}

/**
 * Map dock position to split direction
 */
function positionToDirection(position: DockPosition): LayoutDirection {
  return position === 'left' || position === 'right' ? 'horizontal' : 'vertical';
}

/**
 * Check if position means "before" in the split order
 */
function isPositionBefore(position: DockPosition): boolean {
  return position === 'left' || position === 'top';
}

/**
 * Find a session in the layout tree.
 * Returns the path (array of indices) to the session, or null if not found.
 */
export function findSessionInLayout(sessionId: string, node?: LayoutNode | null): number[] | null {
  const root = node ?? $layout.get().root;
  if (!root) return null;

  if (root.type === 'leaf') {
    return root.sessionId === sessionId ? [] : null;
  }

  for (let i = 0; i < root.children.length; i++) {
    const child = root.children[i];
    if (!child) continue;
    const childPath = findSessionInLayoutNode(sessionId, child);
    if (childPath !== null) {
      return [i, ...childPath];
    }
  }

  return null;
}

function findSessionInLayoutNode(sessionId: string, node: LayoutNode): number[] | null {
  if (node.type === 'leaf') {
    return node.sessionId === sessionId ? [] : null;
  }

  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (!child) continue;
    const childPath = findSessionInLayoutNode(sessionId, child);
    if (childPath !== null) {
      return [i, ...childPath];
    }
  }

  return null;
}

/**
 * Check if a session is in the current layout.
 */
export function isSessionInLayout(sessionId: string): boolean {
  return findSessionInLayout(sessionId) !== null;
}

/**
 * Get all session IDs in the current layout.
 */
export function getLayoutSessionIds(): string[] {
  const root = $layout.get().root;
  if (!root) return [];

  const ids: string[] = [];
  collectSessionIds(root, ids);
  return ids;
}

function collectSessionIds(node: LayoutNode, ids: string[]): void {
  if (node.type === 'leaf') {
    ids.push(node.sessionId);
  } else {
    for (const child of node.children) {
      collectSessionIds(child, ids);
    }
  }
}

/**
 * Dock a session relative to another session in the layout.
 *
 * Cases:
 * 1. No layout active (standalone) - creates new split with both sessions
 * 2. Target is leaf, same direction as parent - insert into parent split
 * 3. Target is leaf, perpendicular direction - replace leaf with new split
 */
export function dockSession(
  targetSessionId: string,
  draggedSessionId: string,
  position: DockPosition,
): void {
  if (targetSessionId === draggedSessionId) return;

  // Ensure terminals exist for both sessions
  ensureTerminalExists(targetSessionId);
  ensureTerminalExists(draggedSessionId);

  const layout = $layout.get();
  const direction = positionToDirection(position);
  const insertBefore = isPositionBefore(position);
  const draggedLeaf: LayoutLeaf = { type: 'leaf', sessionId: draggedSessionId };

  // Remove dragged session from layout if it's already there
  if (isSessionInLayout(draggedSessionId)) {
    undockSession(draggedSessionId, true);
  }

  // Case 1: No layout active - create new split
  if (!layout.root) {
    const targetLeaf: LayoutLeaf = { type: 'leaf', sessionId: targetSessionId };
    const children = insertBefore ? [draggedLeaf, targetLeaf] : [targetLeaf, draggedLeaf];
    $layout.set({
      root: { type: 'split', direction, children },
    });
    $focusedSessionId.set(draggedSessionId);
    return;
  }

  // Case 2/3: Layout exists, find target and modify tree
  const newRoot = insertIntoTree(
    layout.root,
    targetSessionId,
    draggedLeaf,
    direction,
    insertBefore,
  );
  $layout.set({ root: newRoot });
  $focusedSessionId.set(draggedSessionId);
}

/**
 * Insert a new leaf into the tree relative to a target session.
 */
function insertIntoTree(
  node: LayoutNode,
  targetSessionId: string,
  newLeaf: LayoutLeaf,
  direction: LayoutDirection,
  insertBefore: boolean,
): LayoutNode {
  if (node.type === 'leaf') {
    if (node.sessionId === targetSessionId) {
      // Target found - create new split containing both
      const children = insertBefore ? [newLeaf, node] : [node, newLeaf];
      return { type: 'split', direction, children };
    }
    return node;
  }

  // It's a split - check if any direct child is the target
  const targetIndex = node.children.findIndex(
    (child) => child.type === 'leaf' && child.sessionId === targetSessionId,
  );

  if (targetIndex !== -1) {
    // Found target as direct child
    if (node.direction === direction) {
      // Same direction - insert into this split
      const newChildren = [...node.children];
      const insertIndex = insertBefore ? targetIndex : targetIndex + 1;
      newChildren.splice(insertIndex, 0, newLeaf);
      return { ...node, children: newChildren };
    } else {
      // Perpendicular - replace target leaf with new nested split
      const targetLeaf = node.children[targetIndex] as LayoutLeaf;
      const nestedChildren = insertBefore ? [newLeaf, targetLeaf] : [targetLeaf, newLeaf];
      const newChildren = [...node.children];
      newChildren[targetIndex] = { type: 'split', direction, children: nestedChildren };
      return { ...node, children: newChildren };
    }
  }

  // Recurse into children
  const newChildren = node.children.map((child) =>
    insertIntoTree(child, targetSessionId, newLeaf, direction, insertBefore),
  );
  return { ...node, children: newChildren };
}

/**
 * Remove a session from the layout.
 * Collapses parent splits if they become single-child.
 * Dissolves layout entirely if only one session remains.
 *
 * @param skipFocusUpdate - If true, don't update focused session (used during dock)
 */
export function undockSession(sessionId: string, skipFocusUpdate = false): void {
  const layout = $layout.get();
  if (!layout.root) return;

  // If it's the only session, clear layout
  if (layout.root.type === 'leaf') {
    if (layout.root.sessionId === sessionId) {
      $layout.set({ root: null });
      $focusedSessionId.set(null);
      // Select this session as standalone
      $activeSessionId.set(sessionId);
    }
    return;
  }

  // Remove from tree and collapse
  const { node: newRoot, removed } = removeFromTree(layout.root, sessionId);

  if (removed) {
    // Collapse if only one child remains at root
    const collapsedRoot = collapseIfSingleChild(newRoot);

    // If collapsed to a single leaf, dissolve layout entirely
    if (collapsedRoot?.type === 'leaf') {
      $layout.set({ root: null });
      $focusedSessionId.set(null);
      // Select the remaining session as standalone
      $activeSessionId.set(collapsedRoot.sessionId);
      return;
    }

    $layout.set({ root: collapsedRoot });

    // Update focus if removed session was focused
    if (!skipFocusUpdate && $focusedSessionId.get() === sessionId) {
      const remainingSessions = getLayoutSessionIds();
      $focusedSessionId.set(remainingSessions[0] ?? null);
    }

    // Select undocked session as standalone (it's now outside the layout)
    if (!skipFocusUpdate) {
      $activeSessionId.set(sessionId);
    }
  }
}

/**
 * Remove a session from the tree, returning the modified tree.
 */
function removeFromTree(
  node: LayoutNode,
  sessionId: string,
): { node: LayoutNode | null; removed: boolean } {
  if (node.type === 'leaf') {
    if (node.sessionId === sessionId) {
      return { node: null, removed: true };
    }
    return { node, removed: false };
  }

  const newChildren: LayoutNode[] = [];
  let removed = false;

  for (const child of node.children) {
    if (child.type === 'leaf' && child.sessionId === sessionId) {
      removed = true;
      continue;
    }

    if (child.type === 'split') {
      const result = removeFromTree(child, sessionId);
      if (result.removed) {
        removed = true;
        if (result.node) {
          newChildren.push(result.node);
        }
        continue;
      }
    }

    newChildren.push(child);
  }

  if (newChildren.length === 0) {
    return { node: null, removed };
  }

  return {
    node: { ...node, children: newChildren },
    removed,
  };
}

/**
 * Collapse a split node if it has only one child.
 * Recursively collapses nested single-child splits.
 */
function collapseIfSingleChild(node: LayoutNode | null): LayoutNode | null {
  if (!node) return null;
  if (node.type === 'leaf') return node;

  // First collapse children
  const collapsedChildren = node.children
    .map((child) => (child.type === 'split' ? collapseIfSingleChild(child) : child))
    .filter((child): child is LayoutNode => child !== null);

  if (collapsedChildren.length === 0) {
    return null;
  }

  if (collapsedChildren.length === 1) {
    return collapsedChildren[0] ?? null;
  }

  return { ...node, children: collapsedChildren };
}

/**
 * Handle session close - remove from layout if present.
 */
export function handleSessionClosed(sessionId: string): void {
  if (isSessionInLayout(sessionId)) {
    undockSession(sessionId);
  }
}

/**
 * Focus a session within the layout.
 */
export function focusLayoutSession(sessionId: string): void {
  if (isSessionInLayout(sessionId)) {
    $focusedSessionId.set(sessionId);
    // Also update activeSessionId for sidebar highlighting
    $activeSessionId.set(sessionId);
    // Notify server so this session gets priority output delivery
    if (sendActiveSessionHintFn) {
      sendActiveSessionHintFn(sessionId);
    }
  }
}

/**
 * Check if any layout is currently active.
 */
export function isLayoutActive(): boolean {
  return $layout.get().root !== null;
}

// =============================================================================
// Layout Persistence (localStorage)
// =============================================================================

const LAYOUT_STORAGE_KEY = 'midterm-layout';
const FOCUSED_STORAGE_KEY = 'midterm-layout-focused';

/**
 * Save current layout to localStorage.
 */
export function saveLayoutToStorage(): void {
  const layout = $layout.get();
  if (layout.root) {
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout));
    const focusedId = $focusedSessionId.get();
    if (focusedId) {
      localStorage.setItem(FOCUSED_STORAGE_KEY, focusedId);
    }
  } else {
    localStorage.removeItem(LAYOUT_STORAGE_KEY);
    localStorage.removeItem(FOCUSED_STORAGE_KEY);
  }
}

/**
 * Collect session IDs from a layout node.
 */
function collectSessionIdsFromNode(node: LayoutNode | null, ids: string[]): void {
  if (!node) return;
  if (node.type === 'leaf') {
    ids.push(node.sessionId);
  } else {
    for (const child of node.children) {
      collectSessionIdsFromNode(child, ids);
    }
  }
}

/**
 * Filter layout tree to only include valid sessions.
 * Returns null if fewer than 2 sessions remain.
 */
function filterLayoutToValidSessions(node: LayoutNode | null): LayoutNode | null {
  if (!node) return null;

  if (node.type === 'leaf') {
    return getSession(node.sessionId) ? node : null;
  }

  const validChildren: LayoutNode[] = [];
  for (const child of node.children) {
    const filtered = filterLayoutToValidSessions(child);
    if (filtered) {
      validChildren.push(filtered);
    }
  }

  if (validChildren.length === 0) return null;
  if (validChildren.length === 1) return validChildren[0]!;
  return { ...node, children: validChildren };
}

/**
 * Restore layout from localStorage.
 * Validates that sessions still exist before restoring.
 * Falls back to separate sessions on any failure.
 */
export function restoreLayoutFromStorage(): void {
  const stored = localStorage.getItem(LAYOUT_STORAGE_KEY);
  if (!stored) return;

  try {
    const layout = JSON.parse(stored) as { root: LayoutNode | null };
    if (!layout.root) {
      clearLayoutStorage();
      return;
    }

    // Filter to only valid (existing) sessions
    const filteredRoot = filterLayoutToValidSessions(layout.root);

    // Need at least 2 sessions for a layout
    if (!filteredRoot || filteredRoot.type !== 'split') {
      clearLayoutStorage();
      return;
    }

    const ids: string[] = [];
    collectSessionIdsFromNode(filteredRoot, ids);
    if (ids.length < 2) {
      clearLayoutStorage();
      return;
    }

    // Restore layout
    $layout.set({ root: filteredRoot });

    // Restore focused session if valid
    const focusedId = localStorage.getItem(FOCUSED_STORAGE_KEY);
    if (focusedId && ids.includes(focusedId)) {
      $focusedSessionId.set(focusedId);
      $activeSessionId.set(focusedId);
    } else {
      $focusedSessionId.set(ids[0] ?? null);
      $activeSessionId.set(ids[0] ?? null);
    }
  } catch {
    // Any error - clear storage and fall back to separate sessions
    clearLayoutStorage();
  }
}

/**
 * Clear layout data from localStorage.
 */
function clearLayoutStorage(): void {
  localStorage.removeItem(LAYOUT_STORAGE_KEY);
  localStorage.removeItem(FOCUSED_STORAGE_KEY);
}

/**
 * Initialize layout persistence - subscribe to changes.
 */
export function initLayoutPersistence(): void {
  $layout.subscribe(() => saveLayoutToStorage());
}
