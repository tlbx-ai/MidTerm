/**
 * File Browser Preview Panel
 *
 * Shows file content preview in the right panel.
 * Reuses rendering functions from fileViewer module.
 */

import { createLogger } from '../logging';
import type { FileTreeEntry } from './treeApi';
import { escapeHtml } from '../../utils';
import {
  formatSize,
  getExtension,
  highlightCode,
  renderMarkdown,
  isTextFile,
  isImageFile,
  isVideoFile,
  isAudioFile,
  buildViewUrl,
  getFileIcon,
} from '../fileViewer/rendering';

const log = createLogger('filePreview');

export function renderPreview(
  container: HTMLElement,
  entry: FileTreeEntry,
  sessionId: string,
): void {
  container.innerHTML = '';

  if (entry.isDirectory) {
    container.innerHTML = '<div class="preview-empty">Select a file to preview</div>';
    return;
  }

  const ext = getExtension(entry.name).toLowerCase();
  const mime = entry.mimeType ?? '';
  const viewUrl = buildViewUrl(entry.fullPath, sessionId);

  if (isImageFile(entry.name, mime)) {
    container.innerHTML = `<div class="preview-image-container"><img class="preview-image" src="${escapeHtml(viewUrl)}" alt="${escapeHtml(entry.name)}" /></div>`;
    return;
  }

  if (isVideoFile(entry.name, mime)) {
    container.innerHTML = `<video class="preview-video" controls src="${escapeHtml(viewUrl)}"></video>`;
    return;
  }

  if (isAudioFile(entry.name, mime)) {
    container.innerHTML = `<audio class="preview-audio" controls src="${escapeHtml(viewUrl)}"></audio>`;
    return;
  }

  if (isTextFile(ext, mime) || !mime) {
    container.innerHTML = '<div class="preview-loading">Loading...</div>';
    fetchAndRenderText(container, viewUrl, entry.name, ext);
    return;
  }

  container.innerHTML = `
    <div class="preview-binary">
      <div class="preview-binary-icon">${getFileIcon(entry.name, false)}</div>
      <div class="preview-binary-name">${escapeHtml(entry.name)}</div>
      <div class="preview-binary-size">${entry.size !== undefined ? formatSize(entry.size) : 'Unknown size'}</div>
      <a href="${escapeHtml(viewUrl)}" class="preview-download-btn" download>Download</a>
    </div>`;
}

async function fetchAndRenderText(
  container: HTMLElement,
  url: string,
  _name: string,
  ext: string,
): Promise<void> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      container.innerHTML = `<div class="preview-error">Failed to load file (${res.status})</div>`;
      return;
    }

    const text = await res.text();
    const isMarkdown = ext === '.md' || ext === '.markdown';

    if (isMarkdown) {
      container.innerHTML = `<div class="md-content">${renderMarkdown(text)}</div>`;
    } else {
      const highlighted = highlightCode(text, ext);
      container.innerHTML = `<pre class="file-viewer-text">${highlighted}</pre>`;
    }
  } catch (e) {
    log.error(() => `Failed to load preview: ${e}`);
    container.innerHTML = '<div class="preview-error">Failed to load file</div>';
  }
}

export function clearPreview(container: HTMLElement): void {
  container.innerHTML = '<div class="preview-empty">Select a file to preview</div>';
}
