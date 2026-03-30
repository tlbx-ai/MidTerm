/**
 * API Client
 *
 * Type-safe API client generated from OpenAPI spec.
 * C# DTOs -> OpenAPI -> TypeScript types -> openapi-fetch client
 *
 * Types are exported from api/types.ts - import types from there.
 * This module provides the client functions only.
 */

import createClient from 'openapi-fetch';
import type { paths } from '../api.generated';
import type {
  MidTermSettingsPublic,
  MidTermSettingsUpdate,
  CreateSessionRequest,
  SessionInfoDto,
  WorkerBootstrapRequest,
  WorkerBootstrapResponse,
  SessionPromptRequest,
  SessionStateResponse,
  LensTurnRequest,
  LensTurnStartResponse,
  LensInterruptRequest,
  LensCommandAcceptedResponse,
  LensPulseDeltaResponse,
  LensRequestDecisionRequest,
  LensUserInputAnswerRequest,
  LensPulseSnapshotResponse,
  LensPulseEventListResponse,
  CreateHistoryRequest,
  HistoryPatchRequest,
  CreateShareLinkRequest,
  CreateShareLinkResponse,
  ActiveShareGrantListResponse,
  ClaimShareRequest,
  ClaimShareResponse,
  ShareBootstrapResponse,
  AgentSessionFeedResponse,
  AgentSessionVibeResponse,
} from './types';
import {
  approveLensRequestWs,
  attachLensSession,
  declineLensRequestWs,
  detachLensSession,
  getLensEventsWs,
  getLensSnapshotWs,
  interruptLensTurnWs,
  openLensEventSocket,
  resolveLensUserInputWs,
  submitLensTurnWs,
} from './lensWebSocket';

const client = createClient<paths>({ baseUrl: '' });

// Re-export all types from api/types.ts for backward compatibility
export * from './types';

export class LensHttpError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(status: number, detail: string) {
    super(detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}`);
    this.name = 'LensHttpError';
    this.status = status;
    this.detail = detail;
  }
}

export class ApiProblemError extends Error {
  readonly status: number;
  readonly title: string;
  readonly detail: string;
  readonly errorDetails: string;
  readonly errorStage: string;
  readonly exceptionType: string;
  readonly nativeErrorCode: number | null;

  constructor(options: {
    status: number;
    title?: string;
    detail?: string;
    errorDetails?: string;
    errorStage?: string;
    exceptionType?: string;
    nativeErrorCode?: number | null;
  }) {
    const title = options.title?.trim() || `HTTP ${options.status}`;
    const detail = options.detail?.trim() || '';
    super(detail || title);
    this.name = 'ApiProblemError';
    this.status = options.status;
    this.title = title;
    this.detail = detail;
    this.errorDetails = options.errorDetails?.trim() || '';
    this.errorStage = options.errorStage?.trim() || '';
    this.exceptionType = options.exceptionType?.trim() || '';
    this.nativeErrorCode =
      typeof options.nativeErrorCode === 'number' ? options.nativeErrorCode : null;
  }
}

async function throwHttpError(response: Response, fallback: string): Promise<never> {
  const detail = await response
    .text()
    .then((text) => text.trim())
    .catch(() => '');

  if (detail) {
    throw new LensHttpError(response.status, detail);
  }

  throw new LensHttpError(response.status, response.statusText || fallback);
}

async function readResponseBody(response: Response): Promise<string> {
  return response
    .text()
    .then((text) => text.trim())
    .catch(() => '');
}

async function throwApiProblem(response: Response, fallback: string): Promise<never> {
  const body = await readResponseBody(response);
  if (body.startsWith('{')) {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const problem: ConstructorParameters<typeof ApiProblemError>[0] = {
        status: response.status,
        title:
          typeof parsed.title === 'string' && parsed.title.trim()
            ? parsed.title
            : response.statusText || fallback,
        detail:
          typeof parsed.detail === 'string' && parsed.detail.trim()
            ? parsed.detail
            : response.statusText || fallback,
      };
      if (typeof parsed.errorDetails === 'string') {
        problem.errorDetails = parsed.errorDetails;
      }
      if (typeof parsed.errorStage === 'string') {
        problem.errorStage = parsed.errorStage;
      }
      if (typeof parsed.exceptionType === 'string') {
        problem.exceptionType = parsed.exceptionType;
      }
      if (typeof parsed.nativeErrorCode === 'number') {
        problem.nativeErrorCode = parsed.nativeErrorCode;
      }
      throw new ApiProblemError(problem);
    } catch (error) {
      if (error instanceof ApiProblemError) {
        throw error;
      }
    }
  }

  throw new ApiProblemError({
    status: response.status,
    title: response.statusText || fallback,
    detail: body || response.statusText || fallback,
  });
}

async function postJsonWithProblem<TResponse>(
  path: string,
  body?: unknown,
  parse?: (text: string) => TResponse,
): Promise<{ data: TResponse | undefined; response: Response }> {
  const response = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body ?? {}),
  });

  if (!response.ok) {
    await throwApiProblem(response, 'Request failed.');
  }

  const text = await readResponseBody(response);
  return {
    data: text ? (parse ? parse(text) : (JSON.parse(text) as TResponse)) : undefined,
    response,
  };
}

async function fetchLensJson<T>(path: string, fallback: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    await throwHttpError(response, fallback);
  }

  const text = await response.text();
  if (!text.trim()) {
    throw new Error(`${fallback} Response body was empty.`);
  }

  return JSON.parse(text) as T;
}

// =============================================================================
// API Functions
// =============================================================================

// --- Auth ---

export async function login(password: string) {
  return client.POST('/api/auth/login', {
    body: { password },
  });
}

export async function logout() {
  return client.POST('/api/auth/logout');
}

export async function changePassword(currentPassword: string | null, newPassword: string) {
  return client.POST('/api/auth/change-password', {
    body: { currentPassword, newPassword },
  });
}

export async function getAuthStatus() {
  return client.GET('/api/auth/status');
}

export async function getSecurityStatus() {
  return client.GET('/api/security/status');
}

export async function getApiKeys() {
  return client.GET('/api/security/api-keys');
}

export async function createApiKey(name: string) {
  return client.POST('/api/security/api-keys', {
    body: { name },
  });
}

export async function deleteApiKey(id: string) {
  return client.DELETE('/api/security/api-keys/{id}', {
    params: { path: { id } },
  });
}

export async function getFirewallRuleStatus() {
  return client.GET('/api/security/firewall');
}

export async function addFirewallRule() {
  return client.POST('/api/security/firewall');
}

export async function removeFirewallRule() {
  return client.DELETE('/api/security/firewall');
}

// --- Bootstrap ---

export async function getBootstrap() {
  return client.GET('/api/bootstrap');
}

export async function getBootstrapLogin() {
  return client.GET('/api/bootstrap/login');
}

// --- Sessions ---

export async function getSessions() {
  return client.GET('/api/sessions', { cache: 'no-store' });
}

export async function createSession(request?: CreateSessionRequest) {
  return postJsonWithProblem(
    '/api/sessions',
    request,
    (text) => JSON.parse(text) as SessionInfoDto,
  );
}

export async function bootstrapWorker(request: WorkerBootstrapRequest) {
  return postJsonWithProblem(
    '/api/workers/bootstrap',
    request,
    (text) => JSON.parse(text) as WorkerBootstrapResponse,
  );
}

export async function deleteSession(id: string) {
  return client.DELETE('/api/sessions/{id}', {
    params: { path: { id } },
  });
}

export async function resizeSession(id: string, cols: number, rows: number) {
  return client.POST('/api/sessions/{id}/resize', {
    params: { path: { id } },
    body: { cols, rows },
  });
}

export async function renameSession(id: string, name: string, auto = false) {
  return client.PUT('/api/sessions/{id}/name', {
    params: { path: { id }, query: { auto } },
    body: { name },
  });
}

export async function setSessionBookmark(id: string, bookmarkId: string) {
  return client.PUT('/api/sessions/{id}/bookmark', {
    params: { path: { id } },
    body: { bookmarkId },
  });
}

export async function setSessionControl(id: string, agentControlled: boolean): Promise<void> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/control`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ agentControlled }),
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }
}

export async function getSessionAgentVibe(
  id: string,
  tailLines: number,
  activitySeconds: number,
  bellLimit: number,
): Promise<AgentSessionVibeResponse> {
  const { data } = await client.GET('/api/sessions/{id}/agent', {
    params: {
      path: { id },
      query: { tailLines, activitySeconds, bellLimit },
    },
  });

  return data as AgentSessionVibeResponse;
}

export async function getSessionAgentFeed(
  id: string,
  tailLines: number,
  activitySeconds: number,
  bellLimit: number,
): Promise<AgentSessionFeedResponse> {
  const { data } = await client.GET('/api/sessions/{id}/agent/feed', {
    params: {
      path: { id },
      query: { tailLines, activitySeconds, bellLimit },
    },
  });

  return data as AgentSessionFeedResponse;
}

export async function sendSessionPrompt(id: string, request: SessionPromptRequest): Promise<void> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/input/prompt`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }
}

export async function getSessionState(
  id: string,
  includeBuffer = true,
): Promise<SessionStateResponse> {
  const url = new URL(`/api/sessions/${encodeURIComponent(id)}/state`, window.location.origin);
  url.searchParams.set('includeBuffer', includeBuffer ? 'true' : 'false');

  return fetchLensJson<SessionStateResponse>(url.toString(), 'Session state fetch failed.');
}

export async function getSessionBufferTail(
  id: string,
  lines = 120,
  stripAnsi = true,
): Promise<string> {
  const url = new URL(
    `/api/sessions/${encodeURIComponent(id)}/buffer/tail`,
    window.location.origin,
  );
  url.searchParams.set('lines', String(lines));
  url.searchParams.set('stripAnsi', stripAnsi ? 'true' : 'false');

  const response = await fetch(url.toString());
  if (!response.ok) {
    await throwHttpError(response, 'Session buffer tail fetch failed.');
  }

  return response.text();
}

export async function attachSessionLens(id: string): Promise<void> {
  await attachLensSession(id);
}

export async function detachSessionLens(id: string): Promise<void> {
  await detachLensSession(id);
}

export async function sendLensTurn(
  id: string,
  request: LensTurnRequest,
): Promise<LensTurnStartResponse> {
  return submitLensTurnWs(id, request);
}

export async function getLensSnapshot(
  id: string,
  startIndex?: number,
  count?: number,
): Promise<LensPulseSnapshotResponse> {
  return getLensSnapshotWs(id, startIndex, count);
}

export async function getLensEvents(
  id: string,
  afterSequence = 0,
): Promise<LensPulseEventListResponse> {
  return getLensEventsWs(id, afterSequence);
}

export async function interruptLensTurn(
  id: string,
  request: LensInterruptRequest,
): Promise<LensCommandAcceptedResponse> {
  return interruptLensTurnWs(id, request);
}

export async function approveLensRequest(
  id: string,
  requestId: string,
): Promise<LensCommandAcceptedResponse> {
  return approveLensRequestWs(id, requestId);
}

export async function declineLensRequest(
  id: string,
  requestId: string,
  request: LensRequestDecisionRequest = { decision: 'decline' },
): Promise<LensCommandAcceptedResponse> {
  return declineLensRequestWs(id, requestId, request);
}

export async function resolveLensUserInput(
  id: string,
  requestId: string,
  request: LensUserInputAnswerRequest,
): Promise<LensCommandAcceptedResponse> {
  return resolveLensUserInputWs(id, requestId, request);
}

export interface LensEventStreamCallbacks {
  onDelta(delta: LensPulseDeltaResponse): void;
  onSnapshot?(snapshot: LensPulseSnapshotResponse): void;
  onOpen?(): void;
  onError?(error: Event): void;
}

export function openLensEventStream(
  id: string,
  afterSequence: number,
  startIndex: number | undefined,
  count: number | undefined,
  callbacks: LensEventStreamCallbacks,
): () => void {
  return openLensEventSocket(id, afterSequence, startIndex, count, callbacks);
}

// --- Settings ---

export async function getSettings() {
  return client.GET('/api/settings');
}

export async function updateSettings(settings: MidTermSettingsUpdate) {
  return client.PUT('/api/settings', {
    body: settings as unknown as MidTermSettingsPublic,
  });
}

export interface BackgroundImageInfo {
  hasImage: boolean;
  fileName: string | null;
  revision: number;
}

export async function uploadBackgroundImage(file: File): Promise<BackgroundImageInfo> {
  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch('/api/settings/background-image', {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return (await response.json()) as BackgroundImageInfo;
}

export async function deleteBackgroundImage(): Promise<BackgroundImageInfo> {
  const response = await fetch('/api/settings/background-image', {
    method: 'DELETE',
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return (await response.json()) as BackgroundImageInfo;
}

export async function reloadSettings() {
  return client.POST('/api/settings/reload');
}

export async function restartServer(): Promise<Response> {
  return fetch('/api/restart', { method: 'POST' });
}

// --- System ---

export async function getVersion() {
  return client.GET('/api/version', { parseAs: 'text' });
}

export async function getVersionDetails() {
  return client.GET('/api/version/details');
}

export async function getHealth() {
  return client.GET('/api/health');
}

export async function getSystem() {
  return client.GET('/api/system');
}

export async function getPaths() {
  return client.GET('/api/paths');
}

export async function getShells() {
  return client.GET('/api/shells');
}

export async function getUsers() {
  return client.GET('/api/users');
}

export async function getNetworks() {
  return client.GET('/api/networks');
}

// --- Certificates ---

export async function getCertificateInfo() {
  return client.GET('/api/certificate/info');
}

export async function getSharePacket() {
  return client.GET('/api/certificate/share-packet');
}

export async function createShareLink(
  request: CreateShareLinkRequest,
): Promise<CreateShareLinkResponse> {
  const response = await fetch('/api/share/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return (await response.json()) as CreateShareLinkResponse;
}

export async function getActiveShares(limit = 6): Promise<ActiveShareGrantListResponse> {
  const url = new URL('/api/share/active', window.location.origin);
  url.searchParams.set('limit', String(limit));

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(await response.text());
  }

  return (await response.json()) as ActiveShareGrantListResponse;
}

export async function revokeShare(grantId: string): Promise<void> {
  const response = await fetch(`/api/share/${encodeURIComponent(grantId)}`, {
    method: 'DELETE',
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }
}

export async function claimShareLink(request: ClaimShareRequest): Promise<ClaimShareResponse> {
  const response = await fetch('/api/share/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return (await response.json()) as ClaimShareResponse;
}

export async function getShareBootstrap(): Promise<ShareBootstrapResponse> {
  const response = await fetch('/api/share/bootstrap');
  if (!response.ok) {
    throw new Error(await response.text());
  }

  return (await response.json()) as ShareBootstrapResponse;
}

export async function regenerateCertificate(): Promise<Response> {
  return fetch('/api/certificate/regenerate', { method: 'POST' });
}

// --- Updates ---

export async function checkUpdate() {
  return client.GET('/api/update/check');
}

export async function applyUpdate(source?: string) {
  return client.POST('/api/update/apply', {
    params: { query: source ? { source } : {} },
  });
}

export async function getUpdateResult(clear = false) {
  return client.GET('/api/update/result', {
    params: { query: { clear } },
  });
}

export async function deleteUpdateResult() {
  return client.DELETE('/api/update/result');
}

export async function getUpdateLog() {
  return client.GET('/api/update/log', { parseAs: 'text' });
}

// --- History ---

export async function getHistory() {
  return client.GET('/api/history');
}

export async function createHistoryEntry(entry: CreateHistoryRequest) {
  return client.POST('/api/history', {
    body: entry,
  });
}

export async function patchHistoryEntry(id: string, patch: HistoryPatchRequest) {
  return client.PATCH('/api/history/{id}', {
    params: { path: { id } },
    body: patch,
  });
}

export async function toggleHistoryStar(id: string) {
  return client.PUT('/api/history/{id}/star', {
    params: { path: { id } },
  });
}

export async function deleteHistoryEntry(id: string) {
  return client.DELETE('/api/history/{id}', {
    params: { path: { id } },
  });
}

// --- Files ---

export async function registerFilePaths(sessionId: string, paths: string[]) {
  return client.POST('/api/files/register', {
    body: { sessionId, paths },
  });
}

export async function checkFilePaths(paths: string[], sessionId?: string) {
  return client.POST('/api/files/check', {
    params: { query: sessionId ? { sessionId } : {} },
    body: { paths },
  });
}

export async function listDirectory(path: string, sessionId?: string) {
  return client.GET('/api/files/list', {
    params: { query: sessionId ? { path, sessionId } : { path } },
  });
}

export async function resolveFilePath(sessionId: string, path: string, deep = false) {
  return client.GET('/api/files/resolve', {
    params: { query: { sessionId, path, deep } },
  });
}
