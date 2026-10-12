import type { Schemas } from '../../api/types';
import { t } from '../i18n';

export type FileNavigation = Schemas['FileNavigationResponse'];

export async function readFileNavigation(
  path: string,
  sessionId: string,
  signal: AbortSignal,
): Promise<FileNavigation> {
  const params = new URLSearchParams({ path, sessionId });
  const response = await fetch(`/api/files/navigation?${params}`, { signal });
  if (!response.ok) {
    const key =
      response.status === 403
        ? 'fileViewer.errorPermission'
        : response.status === 404
          ? 'fileViewer.fileNotFound'
          : 'fileBrowser.unableToLoad';
    throw new Error(t(key));
  }
  return (await response.json()) as FileNavigation;
}
