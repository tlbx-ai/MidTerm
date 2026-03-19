/**
 * Web Preview API
 *
 * REST wrappers for session-scoped, named web preview contexts.
 */

import { isEmbeddedWebPreviewContext } from './webContext';

export interface WebPreviewSessionInfo {
  sessionId: string;
  previewName: string;
  routeKey: string;
  url: string | null;
  active: boolean;
  targetRevision: number;
}

export interface WebPreviewSessionListResponse {
  previews: WebPreviewSessionInfo[];
}

export interface WebPreviewTargetResponse {
  sessionId: string;
  previewName: string;
  routeKey: string;
  url: string | null;
  active: boolean;
  targetRevision: number;
}

export interface BrowserPreviewClientResponse {
  sessionId: string | null;
  previewName: string;
  routeKey: string;
  previewId: string;
  previewToken: string;
  origin?: string;
}

function buildPreviewQuery(sessionId: string, previewName?: string): string {
  const query = new URLSearchParams();
  query.set('sessionId', sessionId);
  if (previewName) {
    query.set('previewName', previewName);
  }
  return query.toString();
}

/** List all named preview sessions for a terminal session. */
export async function listWebPreviewSessions(sessionId: string): Promise<WebPreviewSessionInfo[]> {
  if (!sessionId) {
    return [];
  }

  try {
    const res = await fetch(`/api/webpreview/previews?${buildPreviewQuery(sessionId)}`);
    if (!res.ok) {
      return [];
    }
    const data = (await res.json()) as WebPreviewSessionListResponse;
    return Array.isArray(data.previews) ? data.previews : [];
  } catch {
    return [];
  }
}

/** Ensure a named preview session exists and return its current metadata. */
export async function ensureWebPreviewSession(
  sessionId: string,
  previewName: string,
): Promise<WebPreviewSessionInfo | null> {
  if (isEmbeddedWebPreviewContext() || !sessionId) {
    return null;
  }

  try {
    const res = await fetch('/api/webpreview/previews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, previewName }),
    });
    if (!res.ok) {
      return null;
    }
    return (await res.json()) as WebPreviewSessionInfo;
  } catch {
    return null;
  }
}

/** Delete a named preview session. */
export async function deleteWebPreviewSession(
  sessionId: string,
  previewName: string,
): Promise<boolean> {
  if (isEmbeddedWebPreviewContext() || !sessionId) {
    return false;
  }

  try {
    const res = await fetch(
      `/api/webpreview/previews?${buildPreviewQuery(sessionId, previewName)}`,
      {
        method: 'DELETE',
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}

/** Set the reverse proxy target URL for a specific named web preview. */
export async function setWebPreviewTarget(
  sessionId: string,
  previewName: string,
  url: string,
): Promise<WebPreviewTargetResponse | null> {
  if (isEmbeddedWebPreviewContext()) {
    return null;
  }

  try {
    const res = await fetch('/api/webpreview/target', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, previewName, url }),
    });
    if (!res.ok) {
      return null;
    }
    return (await res.json()) as WebPreviewTargetResponse;
  } catch {
    return null;
  }
}

/** Get the current reverse proxy target URL and route key for a named web preview. */
export async function getWebPreviewTarget(
  sessionId: string,
  previewName: string,
): Promise<WebPreviewTargetResponse | null> {
  if (!sessionId) {
    return null;
  }

  try {
    const res = await fetch(`/api/webpreview/target?${buildPreviewQuery(sessionId, previewName)}`);
    if (!res.ok) {
      return null;
    }
    return (await res.json()) as WebPreviewTargetResponse;
  } catch {
    return null;
  }
}

/** Clear the reverse proxy target for a named web preview. */
export async function clearWebPreviewTarget(sessionId: string, previewName: string): Promise<void> {
  if (isEmbeddedWebPreviewContext() || !sessionId) {
    return;
  }

  try {
    await fetch(`/api/webpreview/target?${buildPreviewQuery(sessionId, previewName)}`, {
      method: 'DELETE',
    });
  } catch {
    // ignore
  }
}

/** Clear all cookies in the server-side proxy cookie jar for a named preview. */
export async function clearWebPreviewCookies(
  sessionId: string,
  previewName: string,
): Promise<boolean> {
  if (isEmbeddedWebPreviewContext() || !sessionId) {
    return false;
  }

  try {
    const res = await fetch(
      `/api/webpreview/cookies/clear?${buildPreviewQuery(sessionId, previewName)}`,
      {
        method: 'POST',
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}

/** Trigger a soft or hard reload for a named web preview. */
export async function reloadWebPreview(
  sessionId: string,
  previewName: string,
  mode: 'soft' | 'hard',
): Promise<boolean> {
  if (isEmbeddedWebPreviewContext() || !sessionId) {
    return false;
  }

  try {
    const res = await fetch('/api/webpreview/reload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, previewName, mode }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Register a preview client identity for iframe or popup browser bridge traffic. */
export async function createBrowserPreviewClient(
  sessionId: string,
  previewName: string,
): Promise<BrowserPreviewClientResponse | null> {
  if (isEmbeddedWebPreviewContext() || !sessionId) {
    return null;
  }

  try {
    const res = await fetch('/api/browser/preview-client', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, previewName }),
    });
    if (!res.ok) {
      return null;
    }
    return (await res.json()) as BrowserPreviewClientResponse;
  } catch {
    return null;
  }
}

/** Capture a screenshot through the injected browser bridge and return its data URL. */
export async function captureBrowserScreenshotRaw(
  sessionId: string,
  previewId?: string,
  previewName?: string,
): Promise<string | null> {
  try {
    const res = await fetch('/api/browser/screenshot-raw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        ...(previewName ? { previewName } : {}),
        ...(previewId ? { previewId } : {}),
      }),
    });
    if (!res.ok) {
      return null;
    }
    const data = (await res.json()) as {
      success?: boolean;
      result?: string;
    };
    return data.success && typeof data.result === 'string' ? data.result : null;
  } catch {
    return null;
  }
}
