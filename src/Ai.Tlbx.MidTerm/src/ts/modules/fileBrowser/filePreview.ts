/**
 * File Browser Preview Panel
 *
 * Shows file content preview in the right panel.
 * Reuses rendering functions from fileViewer module.
 */

import { createLogger } from '../logging';
import { t } from '../i18n';
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

function buildSaveUrl(sessionId: string): string {
  let url = '/api/files/save';
  if (sessionId) {
    url += `?sessionId=${encodeURIComponent(sessionId)}`;
  }
  return url;
}

export function renderPreview(
  container: HTMLElement,
  entry: FileTreeEntry,
  sessionId: string,
): void {
  container.innerHTML = '';

  if (entry.isDirectory) {
    container.innerHTML = `<div class="preview-empty">${t('fileBrowser.selectFile')}</div>`;
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
    container.innerHTML = `<div class="preview-loading">${t('fileBrowser.loading')}</div>`;
    void fetchAndRenderText(container, viewUrl, entry, sessionId, ext);
    return;
  }

  container.innerHTML = `
    <div class="preview-binary">
      <div class="preview-binary-icon">${getFileIcon(entry.name, false)}</div>
      <div class="preview-binary-name">${escapeHtml(entry.name)}</div>
      <div class="preview-binary-size">${entry.size !== undefined ? formatSize(entry.size) : t('fileBrowser.unknownSize')}</div>
      <a href="${escapeHtml(viewUrl)}" class="preview-download-btn" download>${t('fileBrowser.download')}</a>
    </div>`;
}

async function fetchAndRenderText(
  container: HTMLElement,
  url: string,
  entry: FileTreeEntry,
  sessionId: string,
  ext: string,
): Promise<void> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      container.innerHTML = `<div class="preview-error">${t('fileBrowser.failedToLoad')} (${res.status})</div>`;
      return;
    }

    const text = await res.text();
    const isMarkdown = ext === '.md' || ext === '.markdown';
    renderTextContent(container, entry, sessionId, text, ext, isMarkdown);
  } catch (e) {
    log.error(() => `Failed to load preview: ${String(e)}`);
    container.innerHTML = `<div class="preview-error">${t('fileBrowser.failedToLoad')}</div>`;
  }
}

function renderTextContent(
  container: HTMLElement,
  entry: FileTreeEntry,
  sessionId: string,
  originalText: string,
  ext: string,
  startInEditor: boolean,
): void {
  let currentText = originalText;
  let isEditing = startInEditor;
  let isDirty = false;

  const shell = document.createElement('div');
  shell.className = 'preview-text-shell';

  const toolbar = document.createElement('div');
  toolbar.className = 'preview-toolbar';

  const meta = document.createElement('div');
  meta.className = 'preview-toolbar-meta';

  const name = document.createElement('span');
  name.className = 'preview-toolbar-name';
  name.textContent = entry.name;
  meta.appendChild(name);

  const actions = document.createElement('div');
  actions.className = 'preview-toolbar-actions';

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'preview-editor-btn';
  editBtn.textContent = t('commands.edit');
  editBtn.style.display = isEditing ? 'none' : '';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'preview-save-btn';
  saveBtn.textContent = t('fileViewer.save');
  saveBtn.disabled = true;
  saveBtn.style.display = isEditing ? '' : 'none';

  const body = document.createElement('div');
  body.className = 'preview-text-body';

  const updateDirtyState = (dirty: boolean): void => {
    isDirty = dirty;
    saveBtn.disabled = !dirty;
  };

  const saveCurrentText = async (): Promise<void> => {
    if (!isDirty) return;

    const previousLabel = saveBtn.textContent;
    saveBtn.disabled = true;
    saveBtn.textContent = t('modal.saving');

    try {
      const resp = await fetch(buildSaveUrl(sessionId), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: entry.fullPath,
          content: currentText,
        }),
      });

      if (!resp.ok) {
        log.error(() => `Save failed for ${entry.fullPath}: ${resp.status}`);
        saveBtn.textContent = previousLabel;
        saveBtn.disabled = false;
        return;
      }

      originalText = currentText;
      updateDirtyState(false);
      saveBtn.textContent = previousLabel;
    } catch (e) {
      log.error(() => `Save failed for ${entry.fullPath}: ${String(e)}`);
      saveBtn.textContent = previousLabel;
      saveBtn.disabled = false;
    }
  };

  const renderReadOnly = (): void => {
    body.innerHTML = '';

    if (ext === '.md' || ext === '.markdown') {
      const markdown = document.createElement('div');
      markdown.className = 'md-content';
      markdown.innerHTML = renderMarkdown(currentText);
      body.appendChild(markdown);
      return;
    }

    const pre = document.createElement('pre');
    pre.className = 'file-viewer-text';
    pre.innerHTML = highlightCode(currentText, ext);
    body.appendChild(pre);
  };

  const renderEditor = (): void => {
    body.innerHTML = '';

    const textarea = document.createElement('textarea');
    textarea.className = 'file-viewer-textarea preview-textarea';
    textarea.value = currentText;
    textarea.spellcheck = false;
    textarea.addEventListener('input', () => {
      currentText = textarea.value;
      updateDirtyState(currentText !== originalText);
    });
    textarea.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveCurrentText();
      }
    });
    body.appendChild(textarea);
  };

  const renderMode = (): void => {
    editBtn.style.display = isEditing ? 'none' : '';
    saveBtn.style.display = isEditing ? '' : 'none';

    if (isEditing) {
      renderEditor();
    } else {
      renderReadOnly();
    }
  };

  editBtn.addEventListener('click', () => {
    isEditing = true;
    renderMode();
  });

  saveBtn.addEventListener('click', () => {
    void saveCurrentText();
  });

  actions.appendChild(editBtn);
  actions.appendChild(saveBtn);

  toolbar.appendChild(meta);
  toolbar.appendChild(actions);

  shell.appendChild(toolbar);
  shell.appendChild(body);

  container.innerHTML = '';
  container.appendChild(shell);

  renderMode();
}

export function clearPreview(container: HTMLElement): void {
  container.innerHTML = `<div class="preview-empty">${t('fileBrowser.selectFile')}</div>`;
}
