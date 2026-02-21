/**
 * Web Preview API
 *
 * REST wrappers for setting/getting/clearing the reverse proxy target.
 */

export interface WebPreviewTargetResponse {
  url: string | null;
  active: boolean;
}

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

export async function getWebPreviewTarget(): Promise<WebPreviewTargetResponse | null> {
  try {
    const res = await fetch('/api/webpreview/target');
    if (!res.ok) return null;
    return (await res.json()) as WebPreviewTargetResponse;
  } catch {
    return null;
  }
}

export async function clearWebPreviewTarget(): Promise<void> {
  try {
    await fetch('/api/webpreview/target', { method: 'DELETE' });
  } catch {
    // ignore
  }
}

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
