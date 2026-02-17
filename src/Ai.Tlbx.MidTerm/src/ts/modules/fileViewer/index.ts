/**
 * File Viewer Module
 *
 * Provides a modal viewer for files and directories detected in terminal output.
 * Supports inline preview for images, video, audio, PDF, and text files.
 * Directories show a browsable file listing.
 */

import type { FilePathInfo, DirectoryEntry, DirectoryListResponse } from '../../types';
import { createLogger } from '../logging';
import {
  $activeSessionId,
  $fileViewerDocked,
  $dockedFilePath,
  $commandsPanelDocked,
  $gitPanelDocked,
} from '../../stores';
import { rescaleAllTerminalsImmediate } from '../terminal/scaling';
import { closeCommandsDock } from '../commands/dock';
import { closeGitDock } from '../git/gitDock';
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
  formatDate,
  isTextFile,
  highlightCode,
  renderMarkdown,
} from './rendering';

const log = createLogger('fileViewer');

let modal: HTMLElement | null = null;
let currentPath: string | null = null;
let currentSessionId: string | null = null;
let navigationHistory: string[] = [];
let lastVideoVolume = 0.15;

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

  // Dock panel buttons
  const dockPanel = document.getElementById('file-viewer-dock');
  if (dockPanel) {
    dockPanel.querySelector('#dock-close')?.addEventListener('click', closeDock);
    dockPanel.querySelector('#dock-undock')?.addEventListener('click', undockViewer);
    dockPanel.querySelector('#dock-refresh')?.addEventListener('click', refreshDock);
    dockPanel.querySelector('#dock-download')?.addEventListener('click', () => {
      const path = $dockedFilePath.get();
      if (path) downloadFile(path);
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal && !modal.classList.contains('hidden')) {
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else {
        closeViewer();
      }
    }
  });

  log.info(() => 'File viewer initialized');
}

function toggleFullscreen(): void {
  const content = modal?.querySelector('.file-viewer-modal-content') as HTMLElement;
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    content?.requestFullscreen();
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
  renderInDock(path);

  // Trigger terminal resize
  requestAnimationFrame(rescaleAllTerminalsImmediate);
}

function closeDock(): void {
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

  // Trigger terminal resize
  requestAnimationFrame(rescaleAllTerminalsImmediate);
}

function undockViewer(): void {
  const path = $dockedFilePath.get();
  if (!path) return;

  // Close dock first
  closeDock();

  // Open in modal
  openFile(path);
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
  if (bodyEl) bodyEl.innerHTML = '<div class="file-viewer-loading">Loading...</div>';

  const info = await checkFilePath(path);

  if (!info || !info.exists) {
    if (bodyEl) bodyEl.innerHTML = '<div class="file-viewer-error">File not found</div>';
    return;
  }

  if (info.isDirectory) {
    if (bodyEl)
      bodyEl.innerHTML = '<div class="file-viewer-error">Directories not supported in dock</div>';
  } else {
    await renderFile(path, info, bodyEl!);
  }
}

function closeViewer(): void {
  if (modal) {
    modal.classList.add('hidden');
  }
  currentPath = null;
  currentSessionId = null;
  navigationHistory = [];
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
  const downloadBtn = modal.querySelector('#file-viewer-download') as HTMLButtonElement | null;

  if (titleEl) titleEl.textContent = getFileName(path);
  if (pathEl) pathEl.textContent = path;
  if (bodyEl) bodyEl.innerHTML = '<div class="file-viewer-loading">Loading...</div>';

  if (downloadBtn) {
    downloadBtn.onclick = () => downloadFile(path);
  }

  if (!info) {
    info = await checkFilePath(path);
  }

  if (!info || !info.exists) {
    if (bodyEl) bodyEl.innerHTML = '<div class="file-viewer-error">File not found</div>';
    return;
  }

  if (info.isDirectory) {
    await renderDirectory(path, bodyEl!);
  } else {
    await renderFile(path, info, bodyEl!);
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
    const data = await resp.json();
    return data.results[path] || null;
  } catch (e) {
    log.error(() => `Failed to check file path: ${e}`);
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
      container.innerHTML = `<div class="file-viewer-error">Failed to list directory (${resp.status})</div>`;
      return;
    }

    const data: DirectoryListResponse = await resp.json();
    renderDirectoryListing(data.entries, path, container);
  } catch (e) {
    log.error(() => `Failed to list directory: ${e}`);
    container.innerHTML = '<div class="file-viewer-error">Failed to list directory</div>';
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
      ${entries.length === 0 ? '<div class="file-list-empty">Empty directory</div>' : ''}
    </div>
  `;

  container.innerHTML = html;

  container.querySelectorAll('.file-list-item').forEach((item) => {
    item.addEventListener('click', () => {
      const action = item.getAttribute('data-action');
      if (action === 'back') {
        const prevPath = navigationHistory.pop();
        if (prevPath) openFile(prevPath);
        return;
      }

      const itemPath = item.getAttribute('data-path');
      const isDir = item.getAttribute('data-is-dir') === 'true';
      if (itemPath) {
        if (isDir && currentPath) {
          navigationHistory.push(currentPath);
        }
        openFile(itemPath);
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
    container.innerHTML = `<img class="file-viewer-image" src="${viewUrl}" alt="${escapeHtml(getFileName(path))}" />`;
  } else if (VIDEO_MIMES.includes(mime)) {
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
    container.innerHTML = `<audio class="file-viewer-audio" controls src="${viewUrl}"></audio>`;
  } else if (mime === PDF_MIME) {
    container.innerHTML = `<iframe class="file-viewer-pdf" src="${viewUrl}"></iframe>`;
  } else if (isTextFile(ext, mime, info.isText)) {
    await renderTextFile(path, container);
  } else {
    renderBinaryFile(info, container);
  }
}

async function renderTextFile(path: string, container: Element): Promise<void> {
  try {
    const viewUrl = buildViewUrl(path);
    const resp = await fetch(viewUrl);
    if (!resp.ok) {
      container.innerHTML = '<div class="file-viewer-error">Failed to load file</div>';
      return;
    }

    const text = await resp.text();
    const maxPreviewLength = 500000;
    const truncated = text.length > maxPreviewLength;
    const displayText = truncated ? text.substring(0, maxPreviewLength) : text;
    const ext = getExtension(path).toLowerCase();

    if (ext === '.md') {
      container.innerHTML = `<div class="md-content">${renderMarkdown(displayText)}${truncated ? '<p><em>... (truncated)</em></p>' : ''}</div>`;
    } else {
      const highlighted = highlightCode(displayText, ext);
      const lines = highlighted.split('\n');
      const gutterWidth = Math.max(3, String(lines.length).length);
      const linesHtml = lines
        .map((line, i) => `<div class="code-line" data-line="${i + 1}">${line || ' '}</div>`)
        .join('');
      container.innerHTML = `<pre class="file-viewer-text" style="--gutter-width: ${gutterWidth}ch">${linesHtml}${truncated ? '<div class="code-line">... (truncated)</div>' : ''}</pre>`;
    }
  } catch (e) {
    log.error(() => `Failed to load text file: ${e}`);
    container.innerHTML = '<div class="file-viewer-error">Failed to load file</div>';
  }
}

function renderBinaryFile(info: FilePathInfo, container: Element): void {
  const size = info.size ?? null;
  container.innerHTML = `
    <div class="file-viewer-binary">
      <div class="file-viewer-binary-icon">📄</div>
      <div class="file-viewer-binary-info">
        <div class="file-viewer-binary-type">${info.mimeType || 'Binary file'}</div>
        ${size != null ? `<div class="file-viewer-binary-size">${formatSize(size)}</div>` : ''}
        ${info.modified ? `<div class="file-viewer-binary-modified">Modified: ${formatDate(info.modified)}</div>` : ''}
      </div>
      <p class="file-viewer-binary-hint">Use the download button to save this file.</p>
    </div>
  `;
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
