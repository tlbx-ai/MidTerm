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
  CreateHistoryRequest,
  HistoryPatchRequest,
} from './types';

const client = createClient<paths>({ baseUrl: '' });

// Re-export all types from api/types.ts for backward compatibility
export * from './types';

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

// --- Bootstrap ---

export async function getBootstrap() {
  return client.GET('/api/bootstrap');
}

export async function getBootstrapLogin() {
  return client.GET('/api/bootstrap/login');
}

// --- Sessions ---

export async function getSessions() {
  return client.GET('/api/sessions');
}

export async function createSession(request?: CreateSessionRequest) {
  return client.POST('/api/sessions', {
    body: request,
  });
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

// --- Settings ---

export async function getSettings() {
  return client.GET('/api/settings');
}

export async function updateSettings(settings: MidTermSettingsUpdate) {
  return client.PUT('/api/settings', {
    body: settings as unknown as MidTermSettingsPublic,
  });
}

export async function reloadSettings() {
  return client.POST('/api/settings/reload');
}

// --- System ---

export async function getVersion() {
  return client.GET('/api/version');
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
  return client.GET('/api/update/log');
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

// --- Logs ---

export async function getLogFiles() {
  return client.GET('/api/logs/files');
}

export async function readLogFile(file: string, lines?: number, fromEnd?: boolean) {
  const query: { file: string; lines?: number; fromEnd?: boolean } = { file };
  if (lines !== undefined) query.lines = lines;
  if (fromEnd !== undefined) query.fromEnd = fromEnd;
  return client.GET('/api/logs/read', {
    params: { query },
  });
}

export async function tailLogFile(file: string, position?: number) {
  const query: { file: string; position?: number } = { file };
  if (position !== undefined) query.position = position;
  return client.GET('/api/logs/tail', {
    params: { query },
  });
}
