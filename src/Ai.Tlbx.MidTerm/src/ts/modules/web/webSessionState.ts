import { $activeSessionId } from '../../stores';
import type { BrowserPreviewClientResponse } from './webApi';

type WebPreviewMode = 'hidden' | 'docked' | 'detached';

interface SessionWebPreviewState {
  url: string | null;
  mode: WebPreviewMode;
  dockedClient: BrowserPreviewClientResponse | null;
}

const sessionState = new Map<string, SessionWebPreviewState>();

function ensureState(sessionId: string): SessionWebPreviewState {
  let state = sessionState.get(sessionId);
  if (!state) {
    state = { url: null, mode: 'hidden', dockedClient: null };
    sessionState.set(sessionId, state);
  }
  return state;
}

function getActiveSessionId(): string | null {
  return $activeSessionId.get();
}

/** Get the web preview URL for the active session. */
export function getActiveUrl(): string | null {
  const sessionId = getActiveSessionId();
  if (!sessionId) return null;
  return ensureState(sessionId).url;
}

/** Set the web preview URL for the active session. */
export function setActiveUrl(url: string | null): void {
  const sessionId = getActiveSessionId();
  if (!sessionId) return;
  ensureState(sessionId).url = url;
}

/** Set the web preview URL for a specific session by ID. */
export function setSessionUrl(sessionId: string, url: string | null): void {
  ensureState(sessionId).url = url;
}

/** Get the docked preview client identity for the active session. */
export function getActiveDockedClient(): BrowserPreviewClientResponse | null {
  const sessionId = getActiveSessionId();
  if (!sessionId) return null;
  return ensureState(sessionId).dockedClient;
}

/** Get the docked preview client identity for a specific session. */
export function getSessionDockedClient(
  sessionId: string | null,
): BrowserPreviewClientResponse | null {
  if (!sessionId) return null;
  return ensureState(sessionId).dockedClient;
}

/** Set the docked preview client identity for the active session. */
export function setActiveDockedClient(client: BrowserPreviewClientResponse | null): void {
  const sessionId = getActiveSessionId();
  if (!sessionId) return;
  ensureState(sessionId).dockedClient = client;
}

/** Set the docked preview client identity for a specific session. */
export function setSessionDockedClient(
  sessionId: string,
  client: BrowserPreviewClientResponse | null,
): void {
  ensureState(sessionId).dockedClient = client;
}

/** Get the web preview display mode (hidden, docked, or detached) for the active session. */
export function getActiveMode(): WebPreviewMode {
  const sessionId = getActiveSessionId();
  if (!sessionId) return 'hidden';
  return ensureState(sessionId).mode;
}

/** Set the web preview display mode for the active session. */
export function setActiveMode(mode: WebPreviewMode): void {
  const sessionId = getActiveSessionId();
  if (!sessionId) return;
  ensureState(sessionId).mode = mode;
}

/** Set the web preview display mode for a specific session by ID. */
export function setSessionMode(sessionId: string, mode: WebPreviewMode): void {
  ensureState(sessionId).mode = mode;
}

/** Get the full web preview state (URL and mode) for a specific session. */
export function getSessionState(sessionId: string | null): SessionWebPreviewState | null {
  if (!sessionId) return null;
  return sessionState.get(sessionId) ?? null;
}

/** Remove all stored web preview state for a session. */
export function removeSessionState(sessionId: string): void {
  sessionState.delete(sessionId);
}
