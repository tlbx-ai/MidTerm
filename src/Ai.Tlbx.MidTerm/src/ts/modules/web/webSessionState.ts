import { $activeSessionId } from '../../stores';

type WebPreviewMode = 'hidden' | 'docked' | 'detached';

interface SessionWebPreviewState {
  url: string | null;
  mode: WebPreviewMode;
}

const sessionState = new Map<string, SessionWebPreviewState>();

function ensureState(sessionId: string): SessionWebPreviewState {
  let state = sessionState.get(sessionId);
  if (!state) {
    state = { url: null, mode: 'hidden' };
    sessionState.set(sessionId, state);
  }
  return state;
}

function getActiveSessionId(): string | null {
  return $activeSessionId.get();
}

export function getActiveUrl(): string | null {
  const sessionId = getActiveSessionId();
  if (!sessionId) return null;
  return ensureState(sessionId).url;
}

export function setActiveUrl(url: string | null): void {
  const sessionId = getActiveSessionId();
  if (!sessionId) return;
  ensureState(sessionId).url = url;
}

export function getActiveMode(): WebPreviewMode {
  const sessionId = getActiveSessionId();
  if (!sessionId) return 'hidden';
  return ensureState(sessionId).mode;
}

export function setActiveMode(mode: WebPreviewMode): void {
  const sessionId = getActiveSessionId();
  if (!sessionId) return;
  ensureState(sessionId).mode = mode;
}

export function setSessionMode(sessionId: string, mode: WebPreviewMode): void {
  ensureState(sessionId).mode = mode;
}

export function getSessionState(sessionId: string | null): SessionWebPreviewState | null {
  if (!sessionId) return null;
  return sessionState.get(sessionId) ?? null;
}

export function removeSessionState(sessionId: string): void {
  sessionState.delete(sessionId);
}
