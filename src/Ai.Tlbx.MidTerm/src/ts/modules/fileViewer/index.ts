/**
 * File Viewer Module
 *
 * Provides a modal viewer/editor for files and directories detected in terminal output.
 * Supports inline preview for images, video, audio, PDF, and editable text files.
 * Binary files are shown as line-numbered hex/ASCII dumps.
 * Directories show a browsable file listing.
 */

import type { FilePathInfo, DirectoryEntry, DirectoryListResponse } from '../../types';
import { createLogger } from '../logging';
import { t } from '../i18n';
import { registerBackButtonLayer } from '../navigation/backButtonGuard';
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
  getFileName,
  joinPath,
  getFileIcon,
  formatSize,
  formatViewerHeaderSubtitle,
  formatBinaryDump,
  createLineNumberedEditor,
  createLineNumberedViewer,
} from './rendering';
import {
  copyFileToClipboard,
  downloadFile as triggerFileDownload,
  loadBinaryPreviewPage,
  resolveFilePreviewKind,
} from './shared';
import { createImageView } from './imageView';
import {
  FileEditState,
  confirmFileNavigation,
  releaseFileEdits,
  trackFileEdits,
} from './editState';
import { FileViewLoad, beginFileOpen, isFileOpenCurrent, cancelFileOpen } from './loadState';
import { readFileDocument, writeFileDocument, type FileDocument } from './documentApi';
import { createFileSaveStatus } from './saveStatus';
import { createDocumentNotice } from './documentNotice';
import { FileNavigationHistory } from './navigationHistory';
import type { Schemas } from '../../api/types';

const log = createLogger('fileViewer');

let modal: HTMLElement | null = null;
let currentPath: string | null = null;
let currentSessionId: string | null = null;
const navigationHistory = new FileNavigationHistory();
let parentPath: string | null = null;
let navigationBar: HTMLElement | null = null;
let lastVideoVolume = 0.15;

let isDirty = false;
let isFullContentLoaded = true;
let currentContent = '';
let currentContentIsPartial = false;
let currentFileInfo: FilePathInfo | null = null;
let releaseBackButtonLayer: (() => void) | null = null;
let releaseDockBackButtonLayer: (() => void) | null = null;
let currentEdit: FileEditState | null = null;
let currentEditOwner: HTMLElement | null = null;
let viewerLoad: FileViewLoad | null = null;

function beginViewerLoad(path: string, container: HTMLElement): FileViewLoad {
  viewerLoad?.abort();
  viewerLoad = new FileViewLoad(path, currentSessionId, container);
  return viewerLoad;
}

function cancelViewerLoad(): void {
  cancelFileOpen();
  viewerLoad?.abort();
  viewerLoad = null;
}

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

  backdrop?.addEventListener('click', () => void requestCloseViewer());
  closeBtn?.addEventListener('click', () => void requestCloseViewer());
  maximizeBtn?.addEventListener('click', toggleFullscreen);
  dockBtn?.addEventListener('click', dockViewer);

  modal.querySelector('#file-viewer-save')?.addEventListener('click', () => void saveFile());
  bindModalFileActions(modal);
  initViewerNavigation(modal);
  $activeSessionId.listen((sessionId) => {
    if (
      currentSessionId &&
      sessionId !== currentSessionId &&
      modal &&
      !modal.classList.contains('hidden') &&
      !currentEdit?.dirty
    )
      closeViewer();
  });

  // Dock panel buttons
  const dockPanel = document.getElementById('file-viewer-dock');
  if (dockPanel) {
    dockPanel.querySelector('#dock-close')?.addEventListener('click', () => {
      void requestCloseFileViewerDock();
    });
    dockPanel.querySelector('#dock-undock')?.addEventListener('click', undockViewer);
    dockPanel.querySelector('#dock-refresh')?.addEventListener('click', () => {
      void refreshDock();
    });
    dockPanel.querySelector('#dock-download')?.addEventListener('click', () => {
      const path = $dockedFilePath.get();
      if (path) {
        triggerFileDownload(path, currentSessionId ?? $activeSessionId.get());
      }
    });
    dockPanel.querySelector('#dock-copy')?.addEventListener('click', () => {
      void copyCurrentFileToClipboard($dockedFilePath.get());
    });
    dockPanel.querySelector('#dock-save')?.addEventListener('click', () => void saveFile());
  }

  document.addEventListener('keydown', (e) => {
    if (document.querySelector('.modal-overlay')) return;
    if (e.key === 'Escape' && modal && !modal.classList.contains('hidden')) {
      if (document.fullscreenElement) {
        void document.exitFullscreen();
      } else {
        void requestCloseViewer();
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

function initViewerNavigation(viewer: HTMLElement): void {
  navigationBar = document.createElement('nav');
  navigationBar.className = 'file-viewer-navigation';
  navigationBar.setAttribute('aria-label', t('fileViewer.navigation'));
  for (const [action, symbol] of [
    ['back', '←'],
    ['forward', '→'],
    ['up', '↑'],
  ] as const) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.fileNavigation = action;
    button.textContent = `${symbol} ${t(`fileViewer.${action}`)}`;
    button.addEventListener('click', () => {
      void navigateHistory(action);
    });
    navigationBar.appendChild(button);
  }
  viewer.querySelector('.modal-header')?.insertAdjacentElement('afterend', navigationBar);
  updateNavigationButtons();
}

function bindModalFileActions(viewer: HTMLElement): void {
  viewer.querySelector('#file-viewer-download')?.addEventListener('click', () => {
    if (currentPath) triggerFileDownload(currentPath, currentSessionId);
  });
  viewer.querySelector('#file-viewer-copy')?.addEventListener('click', () => {
    void copyCurrentFileToClipboard();
  });
}

function resetEditState(): void {
  if (currentEditOwner) releaseFileEdits(currentEditOwner);
  currentEditOwner = null;
  currentEdit = null;
  isDirty = false;
  isFullContentLoaded = true;
  currentContent = '';
  currentContentIsPartial = false;
  currentFileInfo = null;
  updateSaveButtonVisibility(false);
  updateFileActionButtons(null);
}

function confirmCurrentFileNavigation(): Promise<boolean> {
  return currentEditOwner ? confirmFileNavigation(currentEditOwner) : Promise.resolve(true);
}

async function requestCloseViewer(): Promise<void> {
  if (await confirmCurrentFileNavigation()) closeViewer();
}

async function requestCloseFileViewerDock(): Promise<void> {
  if (await confirmCurrentFileNavigation()) closeFileViewerDock();
}

function registerDockBackLayer(): void {
  releaseDockBackButtonLayer?.();
  releaseDockBackButtonLayer = registerBackButtonLayer(() => {
    void requestCloseFileViewerDock();
  });
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
  const source = modal?.querySelector<HTMLElement>('.file-viewer-body');
  const dockPanel = document.getElementById('file-viewer-dock');
  const target = dockPanel?.querySelector<HTMLElement>('.file-viewer-dock-body');
  if (!dockPanel || !source || !target) return;

  // Mutual exclusion: close sidebar docks if open
  if ($commandsPanelDocked.get()) closeCommandsDock();
  if ($gitPanelDocked.get()) closeGitDock();

  if (document.fullscreenElement) void document.exitFullscreen();

  // Update stores and show dock
  $dockedFilePath.set(currentPath);
  $fileViewerDocked.set(true);

  const terminalPage = document.getElementById('app');
  dockPanel.classList.remove('hidden');
  terminalPage?.classList.add('file-viewer-docked');

  updateDockHeader(currentPath);
  transferViewerBody(source, target);
  hideModal();
  registerDockBackLayer();
  updateSaveButtonVisibility(currentEdit?.dirty ?? false);

  adjustInnerDockPositions();
  updateAllDockMargins();
  handleDockLayoutChange();
}

export function closeFileViewerDock(): void {
  cancelViewerLoad();
  hideFileDock();
  currentPath = null;
  currentSessionId = null;
  resetEditState();
}

function hideFileDock(): void {
  releaseDockBackButtonLayer?.();
  releaseDockBackButtonLayer = null;
  const dockPanel = document.getElementById('file-viewer-dock');
  const terminalPage = document.getElementById('app');

  if (dockPanel) {
    dockPanel.classList.add('hidden');
  }
  terminalPage?.classList.remove('file-viewer-docked');

  $fileViewerDocked.set(false);
  $dockedFilePath.set(null);

  adjustInnerDockPositions();
  updateAllDockMargins();
  handleDockLayoutChange();
}

export function openFileViewerDock(path: string): void {
  registerDockBackLayer();
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
  if (!currentPath || !modal) return;
  const source = document.querySelector<HTMLElement>('#file-viewer-dock .file-viewer-dock-body');
  const target = modal.querySelector<HTMLElement>('.file-viewer-body');
  if (!source || !target) return;
  showModal();
  updateModalHeader(currentPath);
  transferViewerBody(source, target);
  hideFileDock();
  updateSaveButtonVisibility(currentEdit?.dirty ?? false);
}

function transferViewerBody(source: HTMLElement, target: HTMLElement): void {
  const scrollTop = source.scrollTop;
  const scrollLeft = source.scrollLeft;
  const editor = source.querySelector<HTMLTextAreaElement>('textarea');
  const editorHadFocus = document.activeElement === editor;
  const editorScrollTop = editor?.scrollTop ?? 0;
  const editorScrollLeft = editor?.scrollLeft ?? 0;
  const start = editor?.selectionStart ?? 0;
  const end = editor?.selectionEnd ?? 0;
  target.replaceChildren(...source.childNodes);
  if (viewerLoad?.container === source) viewerLoad.container = target;
  if (currentEdit && currentEditOwner === source) {
    releaseFileEdits(source);
    currentEditOwner = target;
    trackFileEdits(target, currentEdit, currentSessionId ?? '');
  }
  requestAnimationFrame(() => {
    target.scrollTop = scrollTop;
    target.scrollLeft = scrollLeft;
    if (editor?.isConnected) {
      if (editorHadFocus) editor.focus({ preventScroll: true });
      editor.setSelectionRange(start, end);
      editor.scrollTop = editorScrollTop;
      editor.scrollLeft = editorScrollLeft;
    }
  });
}

async function refreshDock(): Promise<void> {
  const path = $dockedFilePath.get();
  const sessionId = currentSessionId;
  if (
    path &&
    (await confirmCurrentFileNavigation()) &&
    path === $dockedFilePath.get() &&
    sessionId === currentSessionId
  ) {
    await renderInDock(path);
  }
}

async function renderInDock(path: string): Promise<void> {
  const dockPanel = document.getElementById('file-viewer-dock');
  if (!dockPanel) return;

  const titleEl = dockPanel.querySelector('.file-viewer-dock-title');
  const pathEl = dockPanel.querySelector('.file-viewer-dock-path');
  const bodyEl = dockPanel.querySelector<HTMLElement>('.file-viewer-dock-body');
  if (!bodyEl) return;

  if (titleEl || pathEl) {
    updateDockHeader(path);
  }
  bodyEl.innerHTML = `<div class="file-viewer-loading">${t('fileViewer.loading')}</div>`;

  resetEditState();

  const load = beginViewerLoad(path, bodyEl);
  const info = await checkFilePath(load);
  if (!load.isActive()) return;

  if (!info || !info.exists) {
    load.container.innerHTML = `<div class="file-viewer-error">${t('fileViewer.fileNotFound')}</div>`;
    updateFileActionButtons(null);
    return;
  }

  currentFileInfo = info;
  updateFileActionButtons(info);

  if (info.isDirectory) {
    load.container.innerHTML = `<div class="file-viewer-error">${t('fileViewer.dirNotSupported')}</div>`;
  } else {
    await renderFile(load, info);
  }
}

function hideModal(): void {
  releaseBackButtonLayer?.();
  releaseBackButtonLayer = null;

  if (modal) {
    modal.classList.add('hidden');
  }
}

function showModal(): void {
  if (!releaseBackButtonLayer) {
    releaseBackButtonLayer = registerBackButtonLayer(() => {
      if (navigationHistory.canBack) void navigateHistory('back');
      else void requestCloseViewer();
    });
  }
  modal?.classList.remove('hidden');
}

function closeViewer(): void {
  cancelViewerLoad();
  hideModal();
  currentPath = null;
  currentSessionId = null;
  navigationHistory.clear();
  resetEditState();
}

export async function openFile(
  path: string,
  info?: FilePathInfo | null,
  request = beginFileOpen(),
  historyAction: 'push' | 'back' | 'forward' = 'push',
): Promise<void> {
  if (!modal) {
    log.error(() => 'File viewer modal not initialized');
    return;
  }

  if (!isFileOpenCurrent(request)) return;
  if (!(await confirmCurrentFileNavigation()) || !isFileOpenCurrent(request)) return;

  commitNavigation(path, request.sessionId, historyAction);

  currentPath = path;
  currentSessionId = request.sessionId;
  showModal();

  const bodyEl = modal.querySelector<HTMLElement>('.file-viewer-body');
  if (!bodyEl) return;

  updateModalHeader(path);
  bodyEl.innerHTML = `<div class="file-viewer-loading">${t('fileViewer.loading')}</div>`;

  resetEditState();
  const load = beginViewerLoad(path, bodyEl);
  await updateNavigation(load);
  if (!load.isActive()) return;

  if (!info) {
    info = await checkFilePath(load);
  }
  if (!load.isActive()) return;

  if (!info || !info.exists) {
    load.container.innerHTML = `<div class="file-viewer-error">${t('fileViewer.fileNotFound')}</div>`;
    updateFileActionButtons(null);
    return;
  }

  currentFileInfo = info;
  updateFileActionButtons(info);

  if (info.isDirectory) {
    await renderDirectory(load);
  } else {
    await renderFile(load, info);
  }
}

function commitNavigation(
  path: string,
  sessionId: string | null,
  action: 'push' | 'back' | 'forward',
): void {
  const previous = navigationHistory.current;
  if (previous && viewerLoad) {
    previous.scrollTop = viewerLoad.container.scrollTop;
    previous.selectedPath =
      viewerLoad.container.querySelector('.file-list-item.selected')?.getAttribute('data-path') ??
      null;
  }
  if (currentSessionId !== sessionId) navigationHistory.clear();
  if (action === 'back') navigationHistory.back();
  else if (action === 'forward') navigationHistory.forward();
  else navigationHistory.push(path);
  parentPath = null;
  updateNavigationButtons();
}

function updateNavigationButtons(): void {
  for (const button of navigationBar?.querySelectorAll<HTMLButtonElement>('button') ?? []) {
    const action = button.dataset.fileNavigation;
    button.disabled =
      action === 'back'
        ? !navigationHistory.canBack
        : action === 'forward'
          ? !navigationHistory.canForward
          : !parentPath;
  }
}

async function updateNavigation(load: FileViewLoad): Promise<void> {
  const params = new URLSearchParams({ path: load.path });
  if (load.sessionId) params.set('sessionId', load.sessionId);
  try {
    const response = await fetch(`/api/files/navigation?${params}`, { signal: load.signal });
    if (!response.ok) return;
    const result = (await response.json()) as Schemas['FileNavigationResponse'];
    if (load.isActive()) parentPath = result.parentPath;
  } catch {
    /* Existing visit history remains usable if hierarchy lookup fails. */
  }
  if (load.isActive()) updateNavigationButtons();
}

async function navigateHistory(action: 'back' | 'forward' | 'up'): Promise<void> {
  const path =
    action === 'back'
      ? navigationHistory.backPath
      : action === 'forward'
        ? navigationHistory.forwardPath
        : parentPath;
  if (!path) return;
  await openFile(path, null, beginFileOpen(currentSessionId), action === 'up' ? 'push' : action);
}

async function checkFilePath(load: FileViewLoad): Promise<FilePathInfo | null> {
  try {
    const sessionId = load.sessionId;
    const url = sessionId
      ? `/api/files/check?sessionId=${encodeURIComponent(sessionId)}`
      : '/api/files/check';
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: [load.path] }),
      signal: load.signal,
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { results: Record<string, FilePathInfo> };
    return load.isActive() ? data.results[load.path] || null : null;
  } catch (e) {
    if (!load.isActive()) return null;
    log.error(() => `Failed to check file path: ${String(e)}`);
    return null;
  }
}

async function renderDirectory(load: FileViewLoad): Promise<void> {
  const path = load.path;
  try {
    const sessionId = load.sessionId;
    let url = `/api/files/list?path=${encodeURIComponent(path)}`;
    if (sessionId) {
      url += `&sessionId=${encodeURIComponent(sessionId)}`;
    }
    const resp = await fetch(url, { signal: load.signal });
    if (!load.isActive()) return;
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      if (!load.isActive()) return;
      log.error(() => `List directory failed: ${resp.status} ${resp.statusText} ${body}`);
      load.container.innerHTML = `<div class="file-viewer-error">${t('fileViewer.failedToList')} (${resp.status})</div>`;
      return;
    }

    const data = (await resp.json()) as DirectoryListResponse;
    if (!load.isActive()) return;
    renderDirectoryListing(data.entries, path, load.container);
  } catch (e) {
    if (!load.isActive()) return;
    log.error(() => `Failed to list directory: ${String(e)}`);
    load.container.innerHTML = `<div class="file-viewer-error">${t('fileViewer.failedToList')}</div>`;
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
        parentPath
          ? `
        <div class="file-list-item file-list-parent" data-action="up">
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
      if (action === 'up') {
        void navigateHistory('up');
        return;
      }

      const itemPath = item.getAttribute('data-path');
      if (itemPath) {
        container.querySelector('.file-list-item.selected')?.classList.remove('selected');
        item.classList.add('selected');
        void openFile(itemPath, null, beginFileOpen(currentSessionId));
      }
    });
  });
  const visit = navigationHistory.current;
  if (visit?.path === basePath) {
    container.querySelectorAll('.file-list-item').forEach((item) => {
      if (item.getAttribute('data-path') === visit.selectedPath) item.classList.add('selected');
    });
    requestAnimationFrame(() => {
      if (currentPath === basePath) (container as HTMLElement).scrollTop = visit.scrollTop;
    });
  }
}

function buildViewUrl(
  path: string,
  sessionId = currentSessionId ?? $activeSessionId.get(),
): string {
  let url = `/api/files/view?path=${encodeURIComponent(path)}`;
  if (sessionId) {
    url += `&sessionId=${encodeURIComponent(sessionId)}`;
  }
  return url;
}

function createCodeStack(): HTMLDivElement {
  const stack = document.createElement('div');
  stack.className = 'file-viewer-code-stack';
  return stack;
}

function updateModalHeader(path: string, metadata?: string | null): void {
  if (!modal) {
    return;
  }

  const titleEl = modal.querySelector('.file-viewer-title');
  const pathEl = modal.querySelector('.file-viewer-path');
  if (titleEl) titleEl.textContent = getFileName(path);
  if (pathEl) pathEl.textContent = formatViewerHeaderSubtitle(path, metadata);
}

function updateDockHeader(path: string, metadata?: string | null): void {
  const dockPanel = document.getElementById('file-viewer-dock');
  if (!dockPanel) {
    return;
  }

  const titleEl = dockPanel.querySelector('.file-viewer-dock-title');
  const pathEl = dockPanel.querySelector('.file-viewer-dock-path');
  if (titleEl) titleEl.textContent = getFileName(path);
  if (pathEl) pathEl.textContent = formatViewerHeaderSubtitle(path, metadata);
}

function updateViewerHeaders(path: string, metadata?: string | null): void {
  updateModalHeader(path, metadata);
  updateDockHeader(path, metadata);
}

function formatBinaryHeaderMetadata(info: FilePathInfo): string {
  const parts = [info.mimeType || t('fileViewer.binaryFile')];
  if (info.size != null) {
    parts.push(formatSize(info.size));
  }
  return parts.join(' | ');
}

async function renderFile(load: FileViewLoad, info: FilePathInfo): Promise<void> {
  const path = load.path;
  const container = load.container;
  const mime = info.mimeType || 'application/octet-stream';
  const viewUrl = buildViewUrl(path, load.sessionId);
  const previewKind = resolveFilePreviewKind(path, mime, info.isText);

  if (previewKind === 'image') {
    updateSaveButtonVisibility(false);
    container.innerHTML = '';
    container.appendChild(createImageView(viewUrl, getFileName(path)));
  } else if (previewKind === 'video') {
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
  } else if (previewKind === 'audio') {
    updateSaveButtonVisibility(false);
    container.innerHTML = `<audio class="file-viewer-audio" controls src="${viewUrl}"></audio>`;
  } else if (previewKind === 'pdf') {
    updateSaveButtonVisibility(false);
    container.innerHTML = `<iframe class="file-viewer-pdf" src="${viewUrl}"></iframe>`;
  } else if (previewKind === 'text') {
    await renderTextFile(load);
  } else {
    await renderBinaryContent(load, info);
  }
}

async function renderTextFile(load: FileViewLoad): Promise<void> {
  try {
    const document = await readFileDocument(load.path, load.sessionId, false, load.signal);
    if (load.isActive()) renderTextDocument(load, document);
  } catch (error) {
    if (!load.isActive()) return;
    log.error(() => `Failed to load text document: ${String(error)}`);
    load.container.innerHTML = `<div class="file-viewer-error">${t('fileViewer.failedToLoadFile')}</div>`;
  }
}

function renderTextDocument(
  load: FileViewLoad,
  snapshot: FileDocument,
  previousOffsets: number[] = [],
): void {
  resetEditState();
  const container = load.container;
  let version = snapshot.version;
  isFullContentLoaded = !snapshot.isTruncated;
  currentContentIsPartial = snapshot.isTruncated;
  currentContent = snapshot.content;
  currentEdit = new FileEditState(load.path, snapshot.content, async (content, reviewedVersion) => {
    const saved = await writeFileDocument(
      load.path,
      load.sessionId,
      content,
      reviewedVersion ?? version,
    );
    version = saved.version;
    snapshot = {
      ...snapshot,
      size: saved.size,
      encoding: saved.encoding,
      lineEnding: saved.lineEnding,
    };
    const updatedNotice = createNotice();
    notice.replaceWith(updatedNotice);
    notice = updatedNotice;
    updateViewerHeaders(
      load.path,
      `${saved.encoding} | ${saved.lineEnding.toUpperCase()} | ${formatSize(saved.size)}`,
    );
  });
  const edit = currentEdit;
  currentEditOwner = container;
  trackFileEdits(container, edit, load.sessionId ?? '');
  updateViewerHeaders(
    load.path,
    `${snapshot.encoding} | ${snapshot.lineEnding.toUpperCase()} | ${formatSize(snapshot.size)}`,
  );
  const stack = createCodeStack();
  const editor = createLineNumberedEditor(snapshot.content);
  const textarea = editor.textarea;
  textarea.readOnly = snapshot.readOnly;
  edit.subscribe(() => {
    if (currentEdit !== edit) return;
    if (textarea.value !== edit.content) editor.setText(edit.content);
    currentContent = edit.content;
    isDirty = edit.dirty;
    updateSaveButtonVisibility(isDirty);
  });
  textarea.addEventListener('input', () => {
    edit.content = textarea.value;
  });
  const status = createFileSaveStatus(edit, {
    readLatest: () => readFileDocument(load.path, load.sessionId, true, load.signal),
    active: () => load.isActive(),
    replace: (latest) => {
      version = latest.version;
      snapshot = latest;
      isFullContentLoaded = !latest.isTruncated;
      currentContentIsPartial = latest.isTruncated;
      textarea.readOnly = latest.readOnly;
      edit.replaceFromDisk(latest.content);
      const updatedNotice = createNotice();
      notice.replaceWith(updatedNotice);
      notice = updatedNotice;
      updateViewerHeaders(
        load.path,
        `${latest.encoding} | ${latest.lineEnding.toUpperCase()} | ${formatSize(latest.size)}`,
      );
    },
  });
  const createNotice = (): HTMLElement =>
    createDocumentNotice(snapshot, {
      read: (full, offset) =>
        readFileDocument(load.path, load.sessionId, full, load.signal, offset),
      active: () => load.isActive(),
      previousOffsets,
      display: (next, history) => {
        renderTextDocument(load, next, history);
      },
    });
  let notice = createNotice();
  stack.append(notice, status, editor.root);
  container.replaceChildren(stack);
  updateSaveButtonVisibility(false);
}

async function renderBinaryContent(load: FileViewLoad, info: FilePathInfo): Promise<void> {
  const path = load.path;
  try {
    const viewUrl = buildViewUrl(path, load.sessionId);
    const fileSize = info.size ?? null;
    const initialPage = await loadBinaryPreviewPage({ viewUrl, fileSize, signal: load.signal });
    if (!load.isActive()) return;
    const container = load.container;
    const stack = createCodeStack();
    const viewer = createLineNumberedViewer(
      formatBinaryDump(initialPage.bytes, initialPage.startOffset),
      ['file-viewer-binary-shell'],
    );
    viewer.pre.classList.add('file-viewer-binary-text');
    updateViewerHeaders(path, formatBinaryHeaderMetadata(info));

    container.innerHTML = '';
    stack.appendChild(viewer.root);

    let nextOffset = initialPage.endOffsetExclusive;

    if (initialPage.hasMore) {
      const loadMoreBtn = document.createElement('button');
      loadMoreBtn.className = 'file-viewer-load-more';
      loadMoreBtn.textContent =
        fileSize != null
          ? `${t('fileViewer.loadMore')} (${formatSize(fileSize)})`
          : t('fileViewer.loadMore');
      loadMoreBtn.addEventListener('click', () => {
        loadMoreBtn.textContent = t('fileViewer.loading');
        loadMoreBtn.disabled = true;
        void loadBinaryPreviewPage({
          viewUrl,
          startOffset: nextOffset,
          fileSize,
          signal: load.signal,
        })
          .then((page) => {
            if (!load.isActive()) return;
            viewer.setText(formatBinaryDump(page.bytes, page.startOffset));
            nextOffset = page.endOffsetExclusive;
            if (page.hasMore) {
              loadMoreBtn.textContent =
                fileSize != null
                  ? `${t('fileViewer.loadMore')} (${formatSize(fileSize)})`
                  : t('fileViewer.loadMore');
              loadMoreBtn.disabled = false;
            } else {
              loadMoreBtn.remove();
            }
          })
          .catch((error: unknown) => {
            if (!load.isActive()) return;
            log.error(() => `Failed to load binary file page: ${String(error)}`);
            loadMoreBtn.textContent =
              fileSize != null
                ? `${t('fileViewer.loadMore')} (${formatSize(fileSize)})`
                : t('fileViewer.loadMore');
            loadMoreBtn.disabled = false;
          });
      });
      stack.appendChild(loadMoreBtn);
    }

    container.appendChild(stack);
    updateSaveButtonVisibility(false);
  } catch (e) {
    if (!load.isActive()) return;
    log.error(() => `Failed to load binary file: ${String(e)}`);
    load.container.innerHTML = `<div class="file-viewer-error">${t('fileViewer.failedToLoadFile')}</div>`;
  }
}

async function saveFile(): Promise<void> {
  const edit = currentEdit;
  if (!edit?.dirty || !isFullContentLoaded) return;
  try {
    await edit.save();
    if (currentEdit === edit) {
      isDirty = edit.dirty;
      updateSaveButtonVisibility(isDirty);
      log.info(() => `File saved: ${edit.path}`);
    }
  } catch (e) {
    log.error(() => `Save failed: ${String(e)}`);
  }
}

function updateSaveButtonVisibility(dirty: boolean): void {
  const modalSaveBtn = modal?.querySelector<HTMLElement>('#file-viewer-save');
  const busy = currentEdit?.saving ?? false;
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    '#file-viewer-save, #dock-save',
  )) {
    button.disabled = busy;
    button.setAttribute('aria-busy', String(busy));
  }
  if (modalSaveBtn) {
    modalSaveBtn.style.display = dirty ? '' : 'none';
  }
  const dockSaveBtn = document.querySelector<HTMLElement>('#dock-save');
  if (dockSaveBtn) {
    dockSaveBtn.style.display = dirty ? '' : 'none';
  }
}

function updateFileActionButtons(info: FilePathInfo | null): void {
  const showFileActions = info?.exists === true && !info.isDirectory;

  for (const selector of [
    '#file-viewer-download',
    '#file-viewer-copy',
    '#dock-download',
    '#dock-copy',
  ]) {
    const button = document.querySelector<HTMLElement>(selector);
    if (!button) {
      continue;
    }

    button.style.display = showFileActions ? '' : 'none';
  }
}

async function copyCurrentFileToClipboard(path?: string | null): Promise<void> {
  const targetPath = path ?? currentPath;
  if (!targetPath) {
    return;
  }

  await copyFileToClipboard({
    path: targetPath,
    sessionId: currentSessionId ?? $activeSessionId.get(),
    mimeType: currentFileInfo?.mimeType,
    size: currentFileInfo?.size,
    isText: currentFileInfo?.isText,
    currentText: currentContent,
    currentTextIsPartial: currentContentIsPartial,
    currentTextIsDirty: isDirty,
  });
}
