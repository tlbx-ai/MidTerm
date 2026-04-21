import type { MidTermSettingsPublic } from '../../api/types';
import { closeHistoryDropdown } from '../history';

export function syncSidebarNavButtons(settings: MidTermSettingsPublic | null | undefined): void {
  const bookmarksButton = document.getElementById('btn-bookmarks');
  const showBookmarks = settings?.showBookmarks !== false;

  if (bookmarksButton instanceof HTMLElement) {
    bookmarksButton.hidden = !showBookmarks;
  }

  if (!showBookmarks) {
    closeHistoryDropdown();
  }
}
