/**
 * File Viewer Module
 *
 * Provides a modal viewer/editor for files and directories detected in terminal output.
 * Supports inline preview for images, video, audio, PDF, and editable text files.
 * Binary files are shown with non-printable byte escaping.
 * Directories show a browsable file listing.
 */

import type { FilePathInfo, DirectoryEntry, DirectoryListResponse } from '../../types';
import { createLogger } from '../logging';
import { t } from '../i18n';
import {
  $activeSessionId,
  $fileViewerDocked,
  $dockedFilePath,
  $commandsPanelDocked,
  $gitPanelDocked,
} from '../../stores';
import { handleDockLayoutChange } from '../terminal/scaling';
import { closeCommandsDock } from '../commands/dock';
import { closeGitDock } from '../git/gitDock';
import { adjustInnerDockPositions, updateAllDockMargins } from '../web';
import { escapeHtml } from '../../utils';
import {
  IMAGE_MIMES,
  VIDEO_MIMES,
  AUDIO_MIMES,
  PDF_MIME,
  getFileName,
  getExtension,
  joinPath,
  getFileIcon,
  formatSize,
  isTextFile,
  renderMarkdown,
  escapeBinaryContent,
} from './rendering';

const log = createLogger('fileViewer');

const SIZE_LIMIT = 500 * 1024;

let modal: HTMLElement | null = null;
let currentPath: string | null = null;
let currentSessionId: string | null = null;
let navigationHistory: string[] = [];
let lastVideoVolume = 0.15;

let isDirty = false;
let isFullContentLoaded = true;
let currentContent = '';

export function initFileViewer(): void {
  modal = document.getElementById('file-viewer-modal');
  if (!modal) {
    log.warn(() => 'File viewer modal element not found');
    return;
  }

  const backdrop = modal.querySelector('.modal-backdrop');
  const closeBtn = modal.querySelector('.modal-close');
  const maximizeBtn = modal.querySelector('#file-viewer-maximize');
  const dockBtn = modal.querySelector('#file-viewer-dock-btn');

  backdrop?.addEventListener('click', closeViewer);
  closeBtn?.addEventListener('click', closeViewer);
  maximizeBtn?.addEventListener('click', toggleFullscreen);
  dockBtn?.addEventListener('click', dockViewer);

  modal.querySelector('#file-viewer-save')?.addEventListener('click', () => void saveFile());

  // Dock panel buttons
  const dockPanel = document.getElementById('file-viewer-dock');
  if (dockPanel) {
    dockPanel.querySelector('#dock-close')?.addEventListener('click', closeFileViewerDock);
    dockPanel.querySelector('#dock-undock')?.addEventListener('click', undockViewer);
    dockPanel.querySelector('#dock-refresh')?.addEventListener('click', () => {
      void refreshDock();
    });
    dockPanel.querySelector('#dock-download')?.addEventListener('click', () => {
      const path = $dockedFilePath.get();
      if (path) downloadFile(path);
    });
    dockPanel.querySelector('#dock-save')?.addEventListener('click', () => void saveFile());
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal && !modal.classList.contains('hidden')) {
      if (document.fullscreenElement) {
        void document.exitFullscreen();
      } else {
        closeViewer();
      }
    }

    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      const modalVisible = modal && !modal.classList.contains('hidden');
      const dockVisible = $fileViewerDocked.get();
      if ((modalVisible || dockVisible) && isDirty && isFullContentLoaded) {
        e.preventDefault();
        void saveFile();
      }
    }
  });

  log.info(() => 'File viewer initialized');
}

function resetEditState(): void {
  isDirty = false;
  isFullContentLoaded = true;
  currentContent = '';
  updateSaveButtonVisibility(false);
}

function toggleFullscreen(): void {
  const content = modal?.querySelector('.file-viewer-modal-content') as HTMLElement | undefined;
  if (document.fullscreenElement) {
    void document.exitFullscreen();
  } else if (content) {
    void content.requestFullscreen();
  }
}

function dockViewer(): void {
  if (!currentPath) return;

  // Mutual exclusion: close sidebar docks if open
  if ($commandsPanelDocked.get()) closeCommandsDock();
  if ($gitPanelDocked.get()) closeGitDock();

  const path = currentPath;
  const sessionId = currentSessionId;

  // Close the modal
  closeViewer();

  // Update stores and show dock
  $dockedFilePath.set(path);
  $fileViewerDocked.set(true);

  // Restore the session ID for the dock
  currentPath = path;
  currentSessionId = sessionId;

  const dockPanel = document.getElementById('file-viewer-dock');
  const terminalPage = document.getElementById('app');

  if (dockPanel) {
    dockPanel.classList.remove('hidden');
  }
  terminalPage?.classList.add('file-viewer-docked');

  // Render the file in dock
  void renderInDock(path);

  adjustInnerDockPositions();
  updateAllDockMargins();
  handleDockLayoutChange();
}

export function closeFileViewerDock(): void {
  const dockPanel = document.getElementById('file-viewer-dock');
  const terminalPage = document.getElementById('app');

  if (dockPanel) {
    dockPanel.classList.add('hidden');
  }
  terminalPage?.classList.remove('file-viewer-docked');

  $fileViewerDocked.set(false);
  $dockedFilePath.set(null);
  currentPath = null;
  currentSessionId = null;
  resetEditState();

  adjustInnerDockPositions();
  updateAllDockMargins();
  handleDockLayoutChange();
}

export function openFileViewerDock(path: string): void {
  $dockedFilePath.set(path);
  $fileViewerDocked.set(true);
  currentPath = path;
  currentSessionId = $activeSessionId.get() ?? null;

  const dockPanel = document.getElementById('file-viewer-dock');
  const terminalPage = document.getElementById('app');
  if (dockPanel) dockPanel.classList.remove('hidden');
  terminalPage?.classList.add('file-viewer-docked');

  void renderInDock(path);

  adjustInnerDockPositions();
  updateAllDockMargins();
  handleDockLayoutChange();
}

function undockViewer(): void {
  const path = $dockedFilePath.get();
  if (!path) return;

  // Close dock first
  closeFileViewerDock();

  // Open in modal
  void openFile(path);
}

async function refreshDock(): Promise<void> {
  const path = $dockedFilePath.get();
  if (path) {
    await renderInDock(path);
  }
}

async function renderInDock(path: string): Promise<void> {
  const dockPanel = document.getElementById('file-viewer-dock');
  if (!dockPanel) return;

  const titleEl = dockPanel.querySelector('.file-viewer-dock-title');
  const pathEl = dockPanel.querySelector('.file-viewer-dock-path');
  const bodyEl = dockPanel.querySelector('.file-viewer-dock-body');

  if (titleEl) titleEl.textContent = getFileName(path);
  if (pathEl) pathEl.textContent = path;
  if (bodyEl)
    bodyEl.innerHTML = `<div class="file-viewer-loading">${t('fileViewer.loading')}</div>`;

  resetEditState();

  const info = await checkFilePath(path);

  if (!info || !info.exists) {
    if (bodyEl)
      bodyEl.innerHTML = `<div class="file-viewer-error">${t('fileViewer.fileNotFound')}</div>`;
    return;
  }

  if (info.isDirectory) {
    if (bodyEl)
      bodyEl.innerHTML = `<div class="file-viewer-error">${t('fileViewer.dirNotSupported')}</div>`;
  } else if (bodyEl) {
    await renderFile(path, info, bodyEl);
  }
}

function closeViewer(): void {
  if (modal) {
    modal.classList.add('hidden');
  }
  currentPath = null;
  currentSessionId = null;
  navigationHistory = [];
  resetEditState();
}

export async function openFile(path: string, info?: FilePathInfo | null): Promise<void> {
  if (!modal) {
    log.error(() => 'File viewer modal not initialized');
    return;
  }

  currentPath = path;
  currentSessionId = $activeSessionId.get() ?? null;
  modal.classList.remove('hidden');

  const titleEl = modal.querySelector('.file-viewer-title');
  const pathEl = modal.querySelector('.file-viewer-path');
  const bodyEl = modal.querySelector('.file-viewer-body');
  const downloadBtn = modal.querySelector<HTMLElement>('#file-viewer-download');

  if (titleEl) titleEl.textContent = getFileName(path);
  if (pathEl) pathEl.textContent = path;
  if (bodyEl)
    bodyEl.innerHTML = `<div class="file-viewer-loading">${t('fileViewer.loading')}</div>`;

  resetEditState();

  if (downloadBtn) {
    downloadBtn.onclick = () => {
      downloadFile(path);
    };
  }

  if (!info) {
    info = await checkFilePath(path);
  }

  if (!info || !info.exists) {
    if (bodyEl)
      bodyEl.innerHTML = `<div class="file-viewer-error">${t('fileViewer.fileNotFound')}</div>`;
    return;
  }

  if (!bodyEl) return;

  if (info.isDirectory) {
    await renderDirectory(path, bodyEl);
  } else {
    await renderFile(path, info, bodyEl);
  }
}

async function checkFilePath(path: string): Promise<FilePathInfo | null> {
  try {
    const sessionId = currentSessionId ?? $activeSessionId.get();
    const url = sessionId
      ? `/api/files/check?sessionId=${encodeURIComponent(sessionId)}`
      : '/api/files/check';
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: [path] }),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { results: Record<string, FilePathInfo> };
    return data.results[path] || null;
  } catch (e) {
    log.error(() => `Failed to check file path: ${String(e)}`);
    return null;
  }
}

async function renderDirectory(path: string, container: Element): Promise<void> {
  try {
    const sessionId = currentSessionId ?? $activeSessionId.get();
    let url = `/api/files/list?path=${encodeURIComponent(path)}`;
    if (sessionId) {
      url += `&sessionId=${encodeURIComponent(sessionId)}`;
    }
    const resp = await fetch(url);
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      log.error(() => `List directory failed: ${resp.status} ${resp.statusText} ${body}`);
      container.innerHTML = `<div class="file-viewer-error">${t('fileViewer.failedToList')} (${resp.status})</div>`;
      return;
    }

    const data = (await resp.json()) as DirectoryListResponse;
    renderDirectoryListing(data.entries, path, container);
  } catch (e) {
    log.error(() => `Failed to list directory: ${String(e)}`);
    container.innerHTML = `<div class="file-viewer-error">${t('fileViewer.failedToList')}</div>`;
  }
}

function renderDirectoryListing(
  entries: DirectoryEntry[],
  basePath: string,
  container: Element,
): void {
  const html = `
    <div class="file-list">
      ${
        navigationHistory.length > 0
          ? `
        <div class="file-list-item file-list-parent" data-action="back">
          <span class="file-icon">📁</span>
          <span class="file-name">..</span>
        </div>
      `
          : ''
      }
      ${entries
        .map((entry) => {
          const name = entry.name;
          const isDir = entry.isDirectory;
          const size = entry.size ?? null;
          return `
        <div class="file-list-item ${isDir ? 'file-list-dir' : 'file-list-file'}"
             data-path="${escapeHtml(joinPath(basePath, name))}"
             data-is-dir="${isDir}">
          <span class="file-icon">${isDir ? '📁' : getFileIcon(name)}</span>
          <span class="file-name">${escapeHtml(name)}</span>
          ${!isDir && size != null ? `<span class="file-size">${formatSize(size)}</span>` : ''}
        </div>
      `;
        })
        .join('')}
      ${entries.length === 0 ? `<div class="file-list-empty">${t('fileViewer.emptyDirectory')}</div>` : ''}
    </div>
  `;

  container.innerHTML = html;

  container.querySelectorAll('.file-list-item').forEach((item) => {
    item.addEventListener('click', () => {
      const action = item.getAttribute('data-action');
      if (action === 'back') {
        const prevPath = navigationHistory.pop();
        if (prevPath) void openFile(prevPath);
        return;
      }

      const itemPath = item.getAttribute('data-path');
      const isDir = item.getAttribute('data-is-dir') === 'true';
      if (itemPath) {
        if (isDir && currentPath) {
          navigationHistory.push(currentPath);
        }
        void openFile(itemPath);
      }
    });
  });
}

function buildViewUrl(path: string): string {
  const sessionId = currentSessionId ?? $activeSessionId.get();
  let url = `/api/files/view?path=${encodeURIComponent(path)}`;
  if (sessionId) {
    url += `&sessionId=${encodeURIComponent(sessionId)}`;
  }
  return url;
}

async function renderFile(path: string, info: FilePathInfo, container: Element): Promise<void> {
  const mime = info.mimeType || 'application/octet-stream';
  const ext = getExtension(path).toLowerCase();
  const viewUrl = buildViewUrl(path);

  if (IMAGE_MIMES.includes(mime)) {
    updateSaveButtonVisibility(false);
    container.innerHTML = `<img class="file-viewer-image" src="${viewUrl}" alt="${escapeHtml(getFileName(path))}" />`;
  } else if (VIDEO_MIMES.includes(mime)) {
    updateSaveButtonVisibility(false);
    const video = document.createElement('video');
    video.className = 'file-viewer-video';
    video.controls = true;
    video.autoplay = true;
    video.muted = true;
    video.src = viewUrl;
    video.volume = lastVideoVolume;
    video.addEventListener('volumechange', () => {
      if (!video.muted) {
        lastVideoVolume = video.volume;
      }
    });
    video.addEventListener(
      'click',
      () => {
        if (video.muted) {
          video.muted = false;
          video.volume = lastVideoVolume;
        }
      },
      { once: true },
    );
    container.innerHTML = '';
    container.appendChild(video);
  } else if (AUDIO_MIMES.includes(mime)) {
    updateSaveButtonVisibility(false);
    container.innerHTML = `<audio class="file-viewer-audio" controls src="${viewUrl}"></audio>`;
  } else if (mime === PDF_MIME) {
    updateSaveButtonVisibility(false);
    container.innerHTML = `<iframe class="file-viewer-pdf" src="${viewUrl}"></iframe>`;
  } else if (isTextFile(ext, mime, info.isText)) {
    await renderTextFile(path, info, container);
  } else {
    await renderBinaryContent(path, info, container);
  }
}

async function renderTextFile(path: string, info: FilePathInfo, container: Element): Promise<void> {
  try {
    const viewUrl = buildViewUrl(path);
    const fileSize = info.size ?? 0;

    let resp: Response;
    if (fileSize > SIZE_LIMIT) {
      resp = await fetch(viewUrl, {
        headers: { Range: `bytes=0-${SIZE_LIMIT - 1}` },
      });
      isFullContentLoaded = false;
    } else {
      resp = await fetch(viewUrl);
      isFullContentLoaded = true;
    }

    if (!resp.ok && resp.status !== 206) {
      container.innerHTML = `<div class="file-viewer-error">${t('fileViewer.failedToLoadFile')}</div>`;
      return;
    }

    const text = await resp.text();
    currentContent = text;
    isDirty = false;

    const ext = getExtension(path).toLowerCase();
    if (ext === '.md') {
      container.innerHTML = `<div class="md-content">${renderMarkdown(text)}${!isFullContentLoaded ? `<p><em>${t('fileViewer.truncated')}</em></p>` : ''}</div>`;
      updateSaveButtonVisibility(false);
      return;
    }

    const textarea = document.createElement('textarea');
    textarea.className = 'file-viewer-textarea';
    textarea.value = text;
    textarea.spellcheck = false;
    textarea.addEventListener('input', () => {
      isDirty = true;
      currentContent = textarea.value;
      updateSaveButtonVisibility(true);
    });

    container.innerHTML = '';
    container.appendChild(textarea);

    if (!isFullContentLoaded) {
      const loadMoreBtn = document.createElement('button');
      loadMoreBtn.className = 'file-viewer-load-more';
      loadMoreBtn.textContent = `${t('fileViewer.loadMore')} (${formatSize(fileSize)})`;
      loadMoreBtn.addEventListener('click', () => {
        loadMoreBtn.textContent = t('fileViewer.loading');
        loadMoreBtn.disabled = true;
        void fetch(viewUrl).then(async (fullResp) => {
          if (fullResp.ok) {
            const fullText = await fullResp.text();
            textarea.value = fullText;
            currentContent = fullText;
            isFullContentLoaded = true;
            loadMoreBtn.remove();
          } else {
            loadMoreBtn.textContent = `${t('fileViewer.loadMore')} (${formatSize(fileSize)})`;
            loadMoreBtn.disabled = false;
          }
        });
      });
      container.appendChild(loadMoreBtn);
    }

    updateSaveButtonVisibility(false);
  } catch (e) {
    log.error(() => `Failed to load text file: ${String(e)}`);
    container.innerHTML = `<div class="file-viewer-error">${t('fileViewer.failedToLoadFile')}</div>`;
  }
}

async function renderBinaryContent(
  path: string,
  info: FilePathInfo,
  container: Element,
): Promise<void> {
  try {
    const viewUrl = buildViewUrl(path);
    const fileSize = info.size ?? 0;

    let resp: Response;
    let partial = false;
    if (fileSize > SIZE_LIMIT) {
      resp = await fetch(viewUrl, { headers: { Range: `bytes=0-${SIZE_LIMIT - 1}` } });
      partial = true;
    } else {
      resp = await fetch(viewUrl);
    }

    if (!resp.ok && resp.status !== 206) {
      container.innerHTML = `<div class="file-viewer-error">${t('fileViewer.failedToLoadFile')}</div>`;
      return;
    }

    const buffer = await resp.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const escaped = escapeBinaryContent(bytes);

    const pre = document.createElement('pre');
    pre.className = 'file-viewer-text file-viewer-binary-text';
    pre.textContent = escaped;

    container.innerHTML = '';

    const infoBar = document.createElement('div');
    infoBar.className = 'file-viewer-binary-bar';
    infoBar.textContent = `${info.mimeType || t('fileViewer.binaryFile')} \u2014 ${formatSize(fileSize)}`;
    container.appendChild(infoBar);
    container.appendChild(pre);

    if (partial) {
      const loadMoreBtn = document.createElement('button');
      loadMoreBtn.className = 'file-viewer-load-more';
      loadMoreBtn.textContent = `${t('fileViewer.loadMore')} (${formatSize(fileSize)})`;
      loadMoreBtn.addEventListener('click', () => {
        loadMoreBtn.textContent = t('fileViewer.loading');
        loadMoreBtn.disabled = true;
        void fetch(viewUrl).then(async (fullResp) => {
          if (fullResp.ok) {
            const fullBuffer = await fullResp.arrayBuffer();
            const fullBytes = new Uint8Array(fullBuffer);
            pre.textContent = escapeBinaryContent(fullBytes);
            loadMoreBtn.remove();
          } else {
            loadMoreBtn.textContent = `${t('fileViewer.loadMore')} (${formatSize(fileSize)})`;
            loadMoreBtn.disabled = false;
          }
        });
      });
      container.appendChild(loadMoreBtn);
    }

    updateSaveButtonVisibility(false);
  } catch (e) {
    log.error(() => `Failed to load binary file: ${String(e)}`);
    container.innerHTML = `<div class="file-viewer-error">${t('fileViewer.failedToLoadFile')}</div>`;
  }
}

async function saveFile(): Promise<void> {
  if (!currentPath || !isDirty || !isFullContentLoaded) return;

  const sessionId = currentSessionId ?? $activeSessionId.get();
  try {
    const saveUrl = sessionId
      ? `/api/files/save?sessionId=${encodeURIComponent(sessionId)}`
      : '/api/files/save';
    const resp = await fetch(saveUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: currentPath, content: currentContent }),
    });

    if (resp.ok) {
      isDirty = false;
      updateSaveButtonVisibility(false);
      log.info(() => `File saved: ${currentPath}`);
    } else {
      log.error(() => `Save failed: ${resp.status}`);
    }
  } catch (e) {
    log.error(() => `Save failed: ${String(e)}`);
  }
}

function updateSaveButtonVisibility(dirty: boolean): void {
  const modalSaveBtn = modal?.querySelector<HTMLElement>('#file-viewer-save');
  if (modalSaveBtn) {
    modalSaveBtn.style.display = dirty ? '' : 'none';
  }
  const dockSaveBtn = document.querySelector<HTMLElement>('#dock-save');
  if (dockSaveBtn) {
    dockSaveBtn.style.display = dirty ? '' : 'none';
  }
}

function downloadFile(path: string): void {
  const sessionId = currentSessionId ?? $activeSessionId.get();
  let url = `/api/files/download?path=${encodeURIComponent(path)}`;
  if (sessionId) {
    url += `&sessionId=${encodeURIComponent(sessionId)}`;
  }
  const link = document.createElement('a');
  link.href = url;
  link.download = getFileName(path);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
