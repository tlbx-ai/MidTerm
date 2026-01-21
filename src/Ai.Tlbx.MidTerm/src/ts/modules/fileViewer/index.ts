/**
 * File Viewer Module
 *
 * Provides a modal viewer for files and directories detected in terminal output.
 * Supports inline preview for images, video, audio, PDF, and text files.
 * Directories show a browsable file listing.
 */

import type { FilePathInfo, DirectoryEntry, DirectoryListResponse } from '../../types';
import { createLogger } from '../logging';

const log = createLogger('fileViewer');

let modal: HTMLElement | null = null;
let currentPath: string | null = null;
let navigationHistory: string[] = [];

const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.json',
  '.xml',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.js',
  '.ts',
  '.jsx',
  '.tsx',
  '.css',
  '.scss',
  '.less',
  '.html',
  '.htm',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.c',
  '.cpp',
  '.h',
  '.hpp',
  '.cs',
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.ps1',
  '.psm1',
  '.bat',
  '.cmd',
  '.sql',
  '.graphql',
  '.proto',
  '.csv',
  '.log',
  '.env',
  '.gitignore',
  '.dockerignore',
  '.editorconfig',
  '.eslintrc',
  '.prettierrc',
  'Makefile',
  'Dockerfile',
  'Vagrantfile',
]);

const IMAGE_MIMES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/bmp',
];
const VIDEO_MIMES = ['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime'];
const AUDIO_MIMES = ['audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/aac'];
const PDF_MIME = 'application/pdf';

export function initFileViewer(): void {
  modal = document.getElementById('file-viewer-modal');
  if (!modal) {
    log.warn(() => 'File viewer modal element not found');
    return;
  }

  const backdrop = modal.querySelector('.modal-backdrop');
  const closeBtn = modal.querySelector('.modal-close');

  backdrop?.addEventListener('click', closeViewer);
  closeBtn?.addEventListener('click', closeViewer);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal && !modal.classList.contains('hidden')) {
      closeViewer();
    }
  });

  log.info(() => 'File viewer initialized');
}

export function closeViewer(): void {
  if (modal) {
    modal.classList.add('hidden');
  }
  currentPath = null;
  navigationHistory = [];
}

export async function openFile(path: string, info?: FilePathInfo): Promise<void> {
  if (!modal) {
    log.error(() => 'File viewer modal not initialized');
    return;
  }

  currentPath = path;
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
    info = (await checkFilePath(path)) ?? undefined;
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
    const resp = await fetch('/api/files/check', {
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
    const resp = await fetch(`/api/files/list?path=${encodeURIComponent(path)}`);
    if (!resp.ok) {
      container.innerHTML = '<div class="file-viewer-error">Failed to list directory</div>';
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
        .map(
          (entry) => `
        <div class="file-list-item ${entry.isDirectory ? 'file-list-dir' : 'file-list-file'}"
             data-path="${escapeHtml(joinPath(basePath, entry.name))}"
             data-is-dir="${entry.isDirectory}">
          <span class="file-icon">${entry.isDirectory ? '📁' : getFileIcon(entry.name)}</span>
          <span class="file-name">${escapeHtml(entry.name)}</span>
          ${!entry.isDirectory && entry.size != null ? `<span class="file-size">${formatSize(entry.size)}</span>` : ''}
        </div>
      `,
        )
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

async function renderFile(path: string, info: FilePathInfo, container: Element): Promise<void> {
  const mime = info.mimeType || 'application/octet-stream';
  const ext = getExtension(path).toLowerCase();

  if (IMAGE_MIMES.includes(mime)) {
    container.innerHTML = `<img class="file-viewer-image" src="/api/files/view?path=${encodeURIComponent(path)}" alt="${escapeHtml(getFileName(path))}" />`;
  } else if (VIDEO_MIMES.includes(mime)) {
    container.innerHTML = `<video class="file-viewer-video" controls src="/api/files/view?path=${encodeURIComponent(path)}"></video>`;
  } else if (AUDIO_MIMES.includes(mime)) {
    container.innerHTML = `<audio class="file-viewer-audio" controls src="/api/files/view?path=${encodeURIComponent(path)}"></audio>`;
  } else if (mime === PDF_MIME) {
    container.innerHTML = `<iframe class="file-viewer-pdf" src="/api/files/view?path=${encodeURIComponent(path)}"></iframe>`;
  } else if (isTextFile(ext, mime)) {
    await renderTextFile(path, container);
  } else {
    renderBinaryFile(info, container);
  }
}

async function renderTextFile(path: string, container: Element): Promise<void> {
  try {
    const resp = await fetch(`/api/files/view?path=${encodeURIComponent(path)}`);
    if (!resp.ok) {
      container.innerHTML = '<div class="file-viewer-error">Failed to load file</div>';
      return;
    }

    const text = await resp.text();
    const maxPreviewLength = 500000;
    const truncated = text.length > maxPreviewLength;
    const displayText = truncated ? text.substring(0, maxPreviewLength) : text;

    container.innerHTML = `
      <pre class="file-viewer-text">${escapeHtml(displayText)}${truncated ? '\n\n... (truncated)' : ''}</pre>
    `;
  } catch (e) {
    log.error(() => `Failed to load text file: ${e}`);
    container.innerHTML = '<div class="file-viewer-error">Failed to load file</div>';
  }
}

function renderBinaryFile(info: FilePathInfo, container: Element): void {
  container.innerHTML = `
    <div class="file-viewer-binary">
      <div class="file-viewer-binary-icon">📄</div>
      <div class="file-viewer-binary-info">
        <div class="file-viewer-binary-type">${info.mimeType || 'Binary file'}</div>
        ${info.size != null ? `<div class="file-viewer-binary-size">${formatSize(info.size)}</div>` : ''}
        ${info.modified ? `<div class="file-viewer-binary-modified">Modified: ${formatDate(info.modified)}</div>` : ''}
      </div>
      <p class="file-viewer-binary-hint">Use the download button to save this file.</p>
    </div>
  `;
}

function downloadFile(path: string): void {
  const link = document.createElement('a');
  link.href = `/api/files/download?path=${encodeURIComponent(path)}`;
  link.download = getFileName(path);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function isTextFile(ext: string, mime: string): boolean {
  if (TEXT_EXTENSIONS.has(ext)) return true;
  if (mime.startsWith('text/')) return true;
  if (mime === 'application/json' || mime === 'application/xml') return true;
  return false;
}

function getFileName(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || path;
}

function getExtension(path: string): string {
  const name = getFileName(path);
  const dotIndex = name.lastIndexOf('.');
  return dotIndex >= 0 ? name.substring(dotIndex) : '';
}

function joinPath(base: string, name: string): string {
  const sep = base.includes('\\') ? '\\' : '/';
  return base.endsWith(sep) ? base + name : base + sep + name;
}

function getFileIcon(name: string): string {
  const ext = getExtension(name).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'].includes(ext)) return '🖼️';
  if (['.mp4', '.webm', '.mov', '.avi'].includes(ext)) return '🎬';
  if (['.mp3', '.wav', '.ogg', '.aac'].includes(ext)) return '🎵';
  if (ext === '.pdf') return '📕';
  if (['.zip', '.tar', '.gz', '.7z', '.rar'].includes(ext)) return '📦';
  if (['.js', '.ts', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.cs'].includes(ext)) return '📝';
  if (['.json', '.xml', '.yaml', '.yml', '.toml'].includes(ext)) return '⚙️';
  return '📄';
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(1) + ' GB';
}

function formatDate(isoDate: string): string {
  try {
    return new Date(isoDate).toLocaleString();
  } catch {
    return isoDate;
  }
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
