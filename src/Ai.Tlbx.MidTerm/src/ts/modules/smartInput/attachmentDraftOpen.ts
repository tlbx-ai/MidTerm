import { checkFilePaths, registerFilePaths } from '../../api/client';
import type { FilePathInfo } from '../../types';
import { t } from '../i18n';
import { showDropToast } from '../terminal';
import type { AppServerControlComposerDraftAttachment } from './appServerControlAttachments';

export async function openAppServerControlDraftAttachment(
  sessionId: string,
  attachment: AppServerControlComposerDraftAttachment,
): Promise<void> {
  const path = attachment.uploadedPath;
  if (!path) {
    showDropToast(t('fileViewer.fileNotFound'));
    return;
  }

  try {
    await registerFilePaths(sessionId, [path]);
    const { data } = await checkFilePaths([path], sessionId);
    const info = data?.results[path] as FilePathInfo | null | undefined;
    if (!info?.exists) {
      showDropToast(t('fileViewer.fileNotFound'));
      return;
    }

    const fileViewer = await import('../fileViewer');
    await fileViewer.openFile(path, info);
  } catch {
    showDropToast(t('fileViewer.fileNotFound'));
  }
}
