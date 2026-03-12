import { $activeSessionId } from '../../stores';
import type {
  BrowserPreviewClientResponse,
  WebPreviewSessionInfo,
  WebPreviewTargetResponse,
} from './webApi';

export type WebPreviewMode = 'hidden' | 'docked' | 'detached';

export interface WebPreviewState {
  previewName: string;
  routeKey: string | null;
  url: string | null;
  active: boolean;
  mode: WebPreviewMode;
  dockedClient: BrowserPreviewClientResponse | null;
}

export interface SessionWebPreviewState {
  selectedPreviewName: string;
  previews: Map<string, WebPreviewState>;
}

export const DEFAULT_PREVIEW_NAME = 'default';

const sessionState = new Map<string, SessionWebPreviewState>();

function buildPreviewState(previewName: string): WebPreviewState {
  return {
    previewName,
    routeKey: null,
    url: null,
    active: false,
    mode: 'hidden',
    dockedClient: null,
  };
}

export function normalizePreviewName(previewName?: string | null): string {
  const normalized = previewName?.trim();
  return normalized ? normalized : DEFAULT_PREVIEW_NAME;
}

function ensureState(sessionId: string): SessionWebPreviewState {
  let state = sessionState.get(sessionId);
  if (!state) {
    state = {
      selectedPreviewName: DEFAULT_PREVIEW_NAME,
      previews: new Map<string, WebPreviewState>(),
    };
    sessionState.set(sessionId, state);
  }

  if (!state.previews.has(DEFAULT_PREVIEW_NAME)) {
    state.previews.set(DEFAULT_PREVIEW_NAME, buildPreviewState(DEFAULT_PREVIEW_NAME));
  }

  return state;
}

function getActiveSessionId(): string | null {
  return $activeSessionId.get();
}

function comparePreviewNames(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  if (a === DEFAULT_PREVIEW_NAME) {
    return -1;
  }
  if (b === DEFAULT_PREVIEW_NAME) {
    return 1;
  }
  return a.localeCompare(b);
}

export function ensurePreviewState(
  sessionId: string,
  previewName?: string | null,
): WebPreviewState {
  const state = ensureState(sessionId);
  const normalized = normalizePreviewName(previewName);
  let preview = state.previews.get(normalized);
  if (!preview) {
    preview = buildPreviewState(normalized);
    state.previews.set(normalized, preview);
  }
  return preview;
}

export function getSessionSelectedPreviewName(sessionId: string | null): string {
  if (!sessionId) {
    return DEFAULT_PREVIEW_NAME;
  }
  return ensureState(sessionId).selectedPreviewName;
}

export function getActivePreviewName(): string {
  return getSessionSelectedPreviewName(getActiveSessionId());
}

export function setSessionSelectedPreviewName(
  sessionId: string,
  previewName?: string | null,
): string {
  const state = ensureState(sessionId);
  const normalized = normalizePreviewName(previewName);
  ensurePreviewState(sessionId, normalized);
  state.selectedPreviewName = normalized;
  return normalized;
}

export function setActiveSelectedPreviewName(previewName?: string | null): string {
  const sessionId = getActiveSessionId();
  if (!sessionId) {
    return normalizePreviewName(previewName);
  }
  return setSessionSelectedPreviewName(sessionId, previewName);
}

export function getSessionPreview(
  sessionId: string | null,
  previewName?: string | null,
): WebPreviewState | null {
  if (!sessionId) {
    return null;
  }
  const normalized = normalizePreviewName(previewName ?? getSessionSelectedPreviewName(sessionId));
  return ensureState(sessionId).previews.get(normalized) ?? null;
}

export function getActivePreview(): WebPreviewState | null {
  const sessionId = getActiveSessionId();
  if (!sessionId) {
    return null;
  }
  return getSessionPreview(sessionId, getSessionSelectedPreviewName(sessionId));
}

export function listSessionPreviews(sessionId: string | null): WebPreviewState[] {
  if (!sessionId) {
    return [];
  }
  const state = ensureState(sessionId);
  return Array.from(state.previews.values()).sort((a, b) =>
    comparePreviewNames(a.previewName, b.previewName),
  );
}

export function upsertSessionPreview(
  preview: WebPreviewSessionInfo | WebPreviewTargetResponse,
): WebPreviewState {
  const state = ensurePreviewState(preview.sessionId, preview.previewName);
  const routeKey = preview.routeKey.trim() ? preview.routeKey : null;
  if (state.routeKey !== routeKey) {
    state.dockedClient = null;
  }
  state.routeKey = routeKey;
  state.url = preview.url ?? null;
  state.active = preview.active;
  ensureState(preview.sessionId).previews.set(state.previewName, state);
  return state;
}

export function syncSessionPreviews(
  sessionId: string,
  previews: WebPreviewSessionInfo[],
): SessionWebPreviewState {
  const state = ensureState(sessionId);
  const seen = new Set<string>();

  for (const preview of previews) {
    const normalized = normalizePreviewName(preview.previewName);
    seen.add(normalized);
    upsertSessionPreview({
      ...preview,
      sessionId,
      previewName: normalized,
    });
  }

  for (const [name, preview] of state.previews) {
    if (name === DEFAULT_PREVIEW_NAME) {
      if (!seen.has(name)) {
        preview.routeKey = null;
        preview.url = null;
        preview.active = false;
        preview.dockedClient = null;
      }
      continue;
    }

    if (!seen.has(name)) {
      state.previews.delete(name);
    }
  }

  if (!state.previews.has(state.selectedPreviewName)) {
    state.selectedPreviewName = DEFAULT_PREVIEW_NAME;
  }

  ensurePreviewState(sessionId, state.selectedPreviewName);
  return state;
}

/** Get the web preview URL for the active selected preview. */
export function getActiveUrl(): string | null {
  return getActivePreview()?.url ?? null;
}

/** Set the web preview URL for the active selected preview. */
export function setActiveUrl(url: string | null): void {
  const sessionId = getActiveSessionId();
  if (!sessionId) {
    return;
  }
  setSessionUrl(sessionId, getSessionSelectedPreviewName(sessionId), url);
}

/** Set the web preview URL for a specific named preview. */
export function setSessionUrl(sessionId: string, previewName: string, url: string | null): void {
  const preview = ensurePreviewState(sessionId, previewName);
  preview.url = url;
  preview.active = !!url;
}

export function setSessionPreviewRouteKey(
  sessionId: string,
  previewName: string,
  routeKey: string | null,
): void {
  const preview = ensurePreviewState(sessionId, previewName);
  const normalized = routeKey?.trim() ? routeKey : null;
  if (preview.routeKey !== normalized) {
    preview.dockedClient = null;
  }
  preview.routeKey = normalized;
}

/** Get the docked preview client identity for the active selected preview. */
export function getActiveDockedClient(): BrowserPreviewClientResponse | null {
  return getActivePreview()?.dockedClient ?? null;
}

/** Get the docked preview client identity for a specific named preview. */
export function getSessionDockedClient(
  sessionId: string | null,
  previewName?: string | null,
): BrowserPreviewClientResponse | null {
  return getSessionPreview(sessionId, previewName)?.dockedClient ?? null;
}

/** Set the docked preview client identity for the active selected preview. */
export function setActiveDockedClient(client: BrowserPreviewClientResponse | null): void {
  const sessionId = getActiveSessionId();
  if (!sessionId) {
    return;
  }
  setSessionDockedClient(sessionId, getSessionSelectedPreviewName(sessionId), client);
}

/** Set the docked preview client identity for a specific named preview. */
export function setSessionDockedClient(
  sessionId: string,
  previewName: string,
  client: BrowserPreviewClientResponse | null,
): void {
  const preview = ensurePreviewState(sessionId, previewName);
  preview.dockedClient = client;
  if (client?.routeKey) {
    preview.routeKey = client.routeKey;
  }
}

/** Get the display mode for the active selected preview. */
export function getActiveMode(): WebPreviewMode {
  return getActivePreview()?.mode ?? 'hidden';
}

/** Set the display mode for the active selected preview. */
export function setActiveMode(mode: WebPreviewMode): void {
  const sessionId = getActiveSessionId();
  if (!sessionId) {
    return;
  }
  setSessionMode(sessionId, getSessionSelectedPreviewName(sessionId), mode);
}

/** Set the display mode for a specific named preview. */
export function setSessionMode(sessionId: string, previewName: string, mode: WebPreviewMode): void {
  ensurePreviewState(sessionId, previewName).mode = mode;
}

/** Get the full preview session state for a session. */
export function getSessionState(sessionId: string | null): SessionWebPreviewState | null {
  if (!sessionId) {
    return null;
  }
  return ensureState(sessionId);
}

/** Remove all stored preview state for a session. */
export function removeSessionState(sessionId: string): void {
  sessionState.delete(sessionId);
}
