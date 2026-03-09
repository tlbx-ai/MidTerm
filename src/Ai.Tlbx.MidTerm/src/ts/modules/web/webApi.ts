/**
 * Web Preview API
 *
 * REST wrappers for setting/getting/clearing the reverse proxy target.
 */

export interface WebPreviewTargetResponse {
  url: string | null;
  active: boolean;
}

export interface BrowserPreviewClientResponse {
  sessionId: string | null;
  previewId: string;
  previewToken: string;
}

/** Set the reverse proxy target URL for the web preview. */
export async function setWebPreviewTarget(url: string): Promise<WebPreviewTargetResponse | null> {
  try {
    const res = await fetch('/api/webpreview/target', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) return null;
    return (await res.json()) as WebPreviewTargetResponse;
  } catch {
    return null;
  }
}

/** Get the current reverse proxy target URL and active status. */
export async function getWebPreviewTarget(): Promise<WebPreviewTargetResponse | null> {
  try {
    const res = await fetch('/api/webpreview/target');
    if (!res.ok) return null;
    return (await res.json()) as WebPreviewTargetResponse;
  } catch {
    return null;
  }
}

/** Clear the reverse proxy target, stopping the web preview proxy. */
export async function clearWebPreviewTarget(): Promise<void> {
  try {
    await fetch('/api/webpreview/target', { method: 'DELETE' });
  } catch {
    // ignore
  }
}

/** Clear all cookies in the server-side proxy cookie jar and on disk. */
export async function clearWebPreviewCookies(): Promise<boolean> {
  try {
    const res = await fetch('/api/webpreview/cookies/clear', { method: 'POST' });
    return res.ok;
  } catch {
    return false;
  }
}

/** Trigger a soft or hard reload of the web preview on the server. */
export async function reloadWebPreview(mode: 'soft' | 'hard'): Promise<boolean> {
  try {
    const res = await fetch('/api/webpreview/reload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Register a preview client identity for iframe/popup browser bridge traffic. */
export async function createBrowserPreviewClient(
  sessionId: string,
): Promise<BrowserPreviewClientResponse | null> {
  try {
    const res = await fetch('/api/browser/preview-client', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    if (!res.ok) return null;
    return (await res.json()) as BrowserPreviewClientResponse;
  } catch {
    return null;
  }
}

/** Capture a screenshot through the injected browser bridge and return its data URL. */
export async function captureBrowserScreenshotRaw(sessionId: string): Promise<string | null> {
  try {
    const res = await fetch('/api/browser/screenshot-raw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      success?: boolean;
      result?: string;
    };
    return data.success && typeof data.result === 'string' ? data.result : null;
  } catch {
    return null;
  }
}
