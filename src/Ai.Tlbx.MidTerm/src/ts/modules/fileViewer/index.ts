/**
 * File Viewer Module
 *
 * Provides a modal viewer for files and directories detected in terminal output.
 * Supports inline preview for images, video, audio, PDF, and text files.
 * Directories show a browsable file listing.
 */

import type { FilePathInfo, DirectoryEntry, DirectoryListResponse } from '../../types';
import { createLogger } from '../logging';
import { $activeSessionId, $fileViewerDocked, $dockedFilePath } from '../../stores';
import { rescaleAllTerminalsImmediate } from '../terminal/scaling';

const log = createLogger('fileViewer');

let modal: HTMLElement | null = null;
let currentPath: string | null = null;
let currentSessionId: string | null = null;
let navigationHistory: string[] = [];
let lastVideoVolume = 0.15;

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
  // Additional languages
  '.lua',
  '.dart',
  '.kt',
  '.swift',
  '.scala',
  '.clj',
  '.cljs',
  '.ex',
  '.exs',
  '.erl',
  '.hrl',
  '.r',
  '.R',
  '.m',
  '.mm',
  '.pl',
  '.pm',
  '.tcl',
  '.v',
  '.vh',
  '.sv',
  '.svh',
  '.vhd',
  '.vhdl',
  '.asm',
  '.s',
  '.S',
  '.f',
  '.f90',
  '.f95',
  '.for',
  // Build systems
  '.cmake',
  '.make',
  '.mk',
  '.gradle',
  '.groovy',
  // Config formats
  '.tf',
  '.hcl',
  '.nix',
  '.dhall',
  '.jsonc',
  '.json5',
  // Modern languages
  '.zig',
  '.nim',
  '.cr',
  '.jl',
  '.elm',
  '.purs',
  '.ml',
  '.mli',
  '.fs',
  '.fsi',
  '.fsx',
  '.vue',
  '.svelte',
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

export function closeViewer(): void {
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

function isTextFile(ext: string, mime: string, serverIsText?: boolean | null): boolean {
  // Server null-byte check is authoritative if available
  if (serverIsText != null) return serverIsText;
  // Fallback to extension/MIME heuristics
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

function renderMarkdown(text: string): string {
  let html = escapeHtml(text);

  // Code blocks (``` ```)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, _lang, code) => {
    return `<pre><code>${code.trim()}</code></pre>`;
  });

  // Inline code (`)
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  // Headers
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Bold and italic
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  html = html.replace(/_([^_]+)_/g, '<em>$1</em>');

  // Links
  html = html.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>',
  );

  // Blockquotes
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

  // Horizontal rules
  html = html.replace(/^---$/gm, '<hr>');
  html = html.replace(/^\*\*\*$/gm, '<hr>');

  // Unordered lists
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

  // Ordered lists
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

  // Paragraphs (lines with content that aren't already wrapped)
  html = html.replace(/^(?!<[hluopb]|<\/|<hr|<code|<blockquote)(.+)$/gm, '<p>$1</p>');

  // Clean up consecutive blockquotes
  html = html.replace(/<\/blockquote>\n<blockquote>/g, '\n');

  // Remove empty paragraphs
  html = html.replace(/<p><\/p>/g, '');

  return html;
}

// Universal syntax highlighting - works across all languages
// Uses pattern recognition instead of per-language keyword lists

// Universal keywords (merged from common programming languages)
const UNIVERSAL_KEYWORDS = [
  'if',
  'else',
  'elif',
  'for',
  'foreach',
  'while',
  'do',
  'switch',
  'case',
  'default',
  'break',
  'continue',
  'return',
  'goto',
  'throw',
  'try',
  'catch',
  'except',
  'finally',
  'with',
  'match',
  'when',
  'then',
  'fi',
  'done',
  'esac',
  'function',
  'func',
  'fn',
  'def',
  'sub',
  'proc',
  'method',
  'lambda',
  'class',
  'struct',
  'interface',
  'trait',
  'impl',
  'enum',
  'union',
  'type',
  'typedef',
  'const',
  'let',
  'var',
  'mut',
  'val',
  'final',
  'public',
  'private',
  'protected',
  'internal',
  'static',
  'readonly',
  'abstract',
  'virtual',
  'async',
  'await',
  'yield',
  'defer',
  'go',
  'import',
  'export',
  'from',
  'use',
  'using',
  'require',
  'include',
  'package',
  'module',
  'namespace',
  'mod',
  'crate',
  'extern',
  'new',
  'delete',
  'extends',
  'implements',
  'override',
  'true',
  'false',
  'True',
  'False',
  'null',
  'nil',
  'None',
  'undefined',
  'void',
  'this',
  'self',
  'super',
  'base',
  'and',
  'or',
  'not',
  'in',
  'is',
  'as',
  'typeof',
  'instanceof',
  'sizeof',
  'exit',
  'local',
  'select',
  'chan',
  'map',
  'range',
  'move',
  'pass',
  'pub',
];

// Build keyword regex once at module load
const RE_KEYWORDS = new RegExp(`\\b(${UNIVERSAL_KEYWORDS.join('|')})\\b`, 'g');

// Pattern regexes (allocated once at module load)
const RE_COMMENT_SLASH = /(\/\/.*$)/gm;
const RE_COMMENT_HASH = /(#(?![[(]).*$)/gm;
const RE_COMMENT_DASHDASH = /(--.*$)/gm;
const RE_STRING_DOUBLE = /(&quot;[^&]*&quot;)/g;
const RE_STRING_SINGLE = /(&#39;[^&]*&#39;)/g;
const RE_STRING_TEMPLATE = /(`[^`]*`)/g;
const RE_NUMBER = /\b(0x[0-9a-fA-F_]+|0b[01_]+|0o[0-7_]+|\d[\d_]*\.?[\d_]*(?:[eE][+-]?\d+)?)\b/g;
const RE_TYPE = /\b([A-Z][a-z]+[A-Za-z0-9]*)\b(?!\s*\()/g;
const RE_FUNCTION_CALL = /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*(?=\()/g;

function highlightCode(text: string, _ext: string): string {
  let escaped = escapeHtml(text);

  // Reset regex lastIndex (required for reused global regexes)
  RE_COMMENT_SLASH.lastIndex = 0;
  RE_COMMENT_HASH.lastIndex = 0;
  RE_COMMENT_DASHDASH.lastIndex = 0;
  RE_STRING_DOUBLE.lastIndex = 0;
  RE_STRING_SINGLE.lastIndex = 0;
  RE_STRING_TEMPLATE.lastIndex = 0;
  RE_NUMBER.lastIndex = 0;
  RE_KEYWORDS.lastIndex = 0;
  RE_TYPE.lastIndex = 0;
  RE_FUNCTION_CALL.lastIndex = 0;

  // 1. Comments first (can contain anything)
  escaped = escaped.replace(RE_COMMENT_SLASH, '<span class="hl-comment">$1</span>');
  escaped = escaped.replace(RE_COMMENT_HASH, '<span class="hl-comment">$1</span>');
  escaped = escaped.replace(RE_COMMENT_DASHDASH, '<span class="hl-comment">$1</span>');

  // 2. Strings (can contain keywords/numbers)
  escaped = escaped.replace(RE_STRING_DOUBLE, '<span class="hl-string">$1</span>');
  escaped = escaped.replace(RE_STRING_SINGLE, '<span class="hl-string">$1</span>');
  escaped = escaped.replace(RE_STRING_TEMPLATE, '<span class="hl-string">$1</span>');

  // 3. Numbers
  escaped = escaped.replace(RE_NUMBER, '<span class="hl-number">$1</span>');

  // 4. Keywords (universal set)
  escaped = escaped.replace(RE_KEYWORDS, '<span class="hl-keyword">$1</span>');

  // 5. Types (PascalCase identifiers not followed by paren)
  escaped = escaped.replace(RE_TYPE, '<span class="hl-type">$1</span>');

  // 6. Function calls (identifier followed by paren)
  escaped = escaped.replace(RE_FUNCTION_CALL, '<span class="hl-function">$1</span>');

  return escaped;
}
