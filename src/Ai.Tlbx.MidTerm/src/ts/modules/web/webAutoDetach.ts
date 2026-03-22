import { detachPreview, isDetachedOpenForSession } from './webDetach';
import { getSessionPreview, getSessionSelectedPreviewName } from './webSessionState';

/**
 * When the user switches away from a session with a live docked preview,
 * move that preview into its own popup so mt_cli can keep driving it.
 */
export async function autoDetachPreviewOnSessionSwitch(
  previousSessionId: string | null,
  nextSessionId: string | null,
): Promise<void> {
  if (!previousSessionId || previousSessionId === nextSessionId) {
    return;
  }

  const previewName = getSessionSelectedPreviewName(previousSessionId);
  const preview = getSessionPreview(previousSessionId, previewName);
  if (!preview || preview.mode !== 'docked' || !preview.url) {
    return;
  }

  if (isDetachedOpenForSession(previousSessionId, previewName)) {
    return;
  }

  await detachPreview(previousSessionId, previewName, { suppressFocus: true });
}
