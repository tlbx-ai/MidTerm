/**
 * Nanostores State Management
 *
 * Reactive state management using nanostores.
 * Replaces imperative state from state.ts with reactive stores.
 *
 * Naming convention: $storeName (dollar prefix for stores)
 *
 * Store types:
 * - atom: single value
 * - map: key-value collection
 * - computed: derived from other stores
 */

import { atom, map, computed } from 'nanostores';
import type {
  Session,
  Settings,
  UpdateInfo,
  AuthStatus,
  ProcessState,
  DisplayLayout,
} from '../types';

// =============================================================================
// Session Stores
// =============================================================================

/**
 * Session collection keyed by session ID.
 * Use $sessions.setKey(id, session) for updates.
 */
export const $sessions = map<Record<string, Session>>({});

/** Currently active session ID */
export const $activeSessionId = atom<string | null>(null);

/** Session currently being renamed (guards input focus during re-renders) */
export const $renamingSessionId = atom<string | null>(null);

/**
 * Pending renames awaiting server confirmation.
 * Maps sessionId -> pending name (null means clearing the name).
 * Protects optimistic updates from being overwritten by stale server state.
 */
const pendingRenames = new Map<string, string | null>();

/**
 * Mark a rename as pending (before optimistic update).
 * The pending name will be preserved until server confirms it.
 */
export function setPendingRename(sessionId: string, name: string | null): void {
  pendingRenames.set(sessionId, name);
}

/**
 * Clear pending rename when server confirms or on rollback.
 */
export function clearPendingRename(sessionId: string): void {
  pendingRenames.delete(sessionId);
}

/**
 * Sessions as a sorted array for rendering.
 * Sorted by _order (which is set from server's order field on load).
 */
export const $sessionList = computed($sessions, (sessions) => {
  return Object.values(sessions).sort((a, b) => (a._order ?? 0) - (b._order ?? 0));
});

/** Current active session object (derived) */
export const $activeSession = computed([$sessions, $activeSessionId], (sessions, activeId) =>
  activeId ? (sessions[activeId] ?? null) : null,
);

/** Whether there are any sessions */
export const $hasSessions = computed($sessionList, (list) => list.length > 0);

// =============================================================================
// Process State Store
// =============================================================================

/**
 * Process state collection keyed by session ID.
 * Tracks foreground process and racing subprocess log.
 */
export const $processStates = map<Record<string, ProcessState>>({});

// =============================================================================
// UI State Stores
// =============================================================================

/** Settings panel visibility */
export const $settingsOpen = atom<boolean>(false);

/** Mobile sidebar visibility */
export const $sidebarOpen = atom<boolean>(false);

/** Desktop sidebar collapsed state */
export const $sidebarCollapsed = atom<boolean>(false);

/** File viewer docked state */
export const $fileViewerDocked = atom<boolean>(false);

/** Docked file path */
export const $dockedFilePath = atom<string | null>(null);

// =============================================================================
// Connection State Stores
// =============================================================================

/** State WebSocket connected flag */
export const $stateWsConnected = atom<boolean>(false);

/** Mux WebSocket connected flag */
export const $muxWsConnected = atom<boolean>(false);

/** Data loss detected for a session (output queue overflow) */
export const $dataLossDetected = atom<{ sessionId: string; timestamp: number } | null>(null);

/** Tracks if mux WebSocket has ever connected (for reconnect detection) */
export const $muxHasConnected = atom<boolean>(false);

/**
 * Connection status (derived).
 * Replaces updateConnectionStatus() function.
 */
export const $connectionStatus = computed(
  [$stateWsConnected, $muxWsConnected],
  (stateConnected, muxConnected): 'connected' | 'disconnected' | 'reconnecting' => {
    if (stateConnected && muxConnected) return 'connected';
    if (!stateConnected && !muxConnected) return 'disconnected';
    return 'reconnecting';
  },
);

// =============================================================================
// Data Stores
// =============================================================================

/** User settings from server */
export const $currentSettings = atom<Settings | null>(null);

/** Update info from server */
export const $updateInfo = atom<UpdateInfo | null>(null);

/** Auth status from server */
export const $authStatus = atom<AuthStatus | null>(null);

/** Windows build number for ConPTY configuration (null on non-Windows) */
export const $windowsBuildNumber = atom<number | null>(null);

/** Server hostname for tab title */
export const $serverHostname = atom<string>('');

/** Voice server password for authentication */
export const $voiceServerPassword = atom<string | null>(null);

/** Settings WebSocket connected flag */
export const $settingsWsConnected = atom<boolean>(false);

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get session by ID from the store.
 * Convenience function for quick lookups.
 */
export function getSession(sessionId: string): Session | undefined {
  return $sessions.get()[sessionId];
}

/**
 * Update a session in the store.
 * Creates if doesn't exist, updates if exists.
 * Preserves _order for existing sessions, assigns high order for new ones.
 */
export function setSession(session: Session): void {
  const existing = $sessions.get()[session.id];
  const order = session._order ?? existing?._order ?? Date.now();
  $sessions.setKey(session.id, { ...session, _order: order });
}

/**
 * Remove a session from the store.
 */
export function removeSession(sessionId: string): void {
  const sessions = { ...$sessions.get() };
  delete sessions[sessionId];
  $sessions.set(sessions);
}

/**
 * Set all sessions (replaces entire collection).
 * Used when receiving session list from server.
 * Uses server's order field if present, otherwise array index.
 * Preserves pending rename names until server confirms them.
 */
export function setSessions(sessionList: Session[]): void {
  const sessionsMap: Record<string, Session> = {};
  sessionList.forEach((session, i) => {
    let name = session.name;

    // Check for pending rename
    const pendingName = pendingRenames.get(session.id);
    if (pendingName !== undefined) {
      if (session.name === pendingName) {
        // Server confirmed our rename - clear pending
        pendingRenames.delete(session.id);
      } else {
        // Server still has old name - preserve our pending name
        name = pendingName;
      }
    }

    sessionsMap[session.id] = { ...session, name, _order: session.order ?? i };
  });
  $sessions.set(sessionsMap);
}

/**
 * Get process state by session ID.
 */
export function getProcessState(sessionId: string): ProcessState | undefined {
  return $processStates.get()[sessionId];
}

/**
 * Set process state for a session.
 */
export function setProcessState(sessionId: string, state: ProcessState): void {
  $processStates.setKey(sessionId, state);
}

/**
 * Remove process state for a session.
 */
export function removeProcessState(sessionId: string): void {
  const states = { ...$processStates.get() };
  delete states[sessionId];
  $processStates.set(states);
}

/**
 * Reorder sessions by moving a session from one index to another.
 * Updates _order values for all affected sessions.
 */
export function reorderSessions(fromIndex: number, toIndex: number): void {
  if (fromIndex === toIndex) return;

  const sessionList = $sessionList.get();
  if (fromIndex < 0 || fromIndex >= sessionList.length) return;
  if (toIndex < 0 || toIndex >= sessionList.length) return;

  const reordered = [...sessionList];
  const moved = reordered.splice(fromIndex, 1)[0];
  if (!moved) return;
  reordered.splice(toIndex, 0, moved);

  const sessionsMap: Record<string, Session> = {};
  reordered.forEach((session, i) => {
    sessionsMap[session.id] = { ...session, _order: i };
  });
  $sessions.set(sessionsMap);
}

// =============================================================================
// Layout Stores
// =============================================================================

/** The current layout tree (null root when showing standalone session) */
export const $layout = atom<DisplayLayout>({ root: null });

/** Focused session within the layout (for keyboard input routing) */
export const $focusedSessionId = atom<string | null>(null);
