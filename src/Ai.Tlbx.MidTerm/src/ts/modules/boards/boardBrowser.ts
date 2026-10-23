import { boardRequest, type BoardItem } from './boardApi';
import { createBrowserPreviewClient, type WebPreviewSessionInfo } from '../web/webApi';

const mounts = new WeakMap<HTMLIFrameElement, { key: string }>();

/** Reuse the complete tlbx preview surface and its sandboxed command bridge. */
export async function mountBoardBrowser(
  frame: HTMLIFrameElement,
  boardId: string,
  item: BoardItem,
): Promise<void> {
  if (!item.localDirectory && !item.url && !item.browserSessionId) return;
  const key = JSON.stringify([
    boardId,
    item.id,
    item.localDirectory,
    item.url,
    item.browserSessionId,
    item.browserPreviewName,
  ]);
  if (mounts.get(frame)?.key === key) return;
  const state = { key };
  mounts.set(frame, state);
  try {
    const preview = await boardRequest<WebPreviewSessionInfo>(
      `/${boardId}/items/${item.id}/browser`,
      'POST',
      {},
    );
    const client = await createBrowserPreviewClient(preview.sessionId, preview.previewName);
    if (!client) throw new Error('Browser preview could not be registered.');
    if (!frame.isConnected || mounts.get(frame) !== state) return;
    const query = new URLSearchParams({
      session: preview.sessionId,
      preview: preview.previewName,
      routeKey: client.routeKey,
      previewId: client.previewId,
      previewToken: client.previewToken,
      sandbox: '1',
      embedded: '1',
    });
    if (client.origin) query.set('origin', client.origin);
    if (preview.url) query.set('url', preview.url);
    // The outer document is tlbx's trusted browser shell; its content frame stays sandboxed.
    frame.removeAttribute('sandbox');
    frame.src = `/web-preview-popup.html?${query}`;
    frame.removeAttribute('data-error');
  } catch (error) {
    frame.dataset.error = error instanceof Error ? error.message : String(error);
    frame.title = frame.dataset.error;
    mounts.delete(frame);
  }
}
