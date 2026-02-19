/**
 * Web Preview Module
 *
 * In-app website preview with reverse proxy.
 * Shows a dockable iframe panel that can be detached to a popup window.
 */

import { setWebClickHandler } from '../sessionTabs';
import { toggleWebPreviewDock, closeWebPreviewDock, setupWebPreviewDockResize } from './webDock';
import { initWebPanel } from './webPanel';
import { initDetach } from './webDetach';

export function initWebPreview(): void {
  setWebClickHandler(() => {
    toggleWebPreviewDock();
  });

  initWebPanel();
  initDetach();

  document.getElementById('web-preview-close')?.addEventListener('click', closeWebPreviewDock);
  setupWebPreviewDockResize();
}

export { closeWebPreviewDock } from './webDock';
export { adjustInnerDockPositions, updateAllDockMargins } from './webDock';
