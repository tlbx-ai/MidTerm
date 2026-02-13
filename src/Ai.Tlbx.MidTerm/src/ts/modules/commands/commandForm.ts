/**
 * Command Form
 *
 * Inline create/edit form for script files.
 * Name + extension dropdown + content textarea.
 */

import { escapeHtml } from '../../utils';
import type { ScriptDefinition } from './commandsApi';

export interface ScriptFormData {
  name: string;
  extension: string;
  content: string;
}

const EXTENSIONS = ['.ps1', '.sh', '.cmd', '.bat', '.zsh'] as const;

function getDefaultExtension(): string {
  const isWindows = /Windows|Win32|Win64/i.test(navigator.userAgent);
  const isMac = /Mac/i.test(navigator.userAgent);
  if (isWindows) return '.ps1';
  if (isMac) return '.zsh';
  return '.sh';
}

export function createCommandForm(
  container: HTMLElement,
  existing?: ScriptDefinition,
  onSave?: (data: ScriptFormData) => void,
  onCancel?: () => void,
): void {
  const isEdit = !!existing;
  const defaultExt = existing?.extension ?? getDefaultExtension();

  const extensionOptions = EXTENSIONS.map(
    (ext) => `<option value="${ext}" ${ext === defaultExt ? 'selected' : ''}>${ext}</option>`,
  ).join('');

  container.innerHTML = `
    <div class="command-form">
      <div class="command-form-name-row">
        <input class="command-form-name" type="text" placeholder="Script name"
          value="${existing ? escapeHtml(existing.name) : ''}" ${isEdit ? 'readonly' : ''} />
        <select class="command-form-ext" ${isEdit ? 'disabled' : ''}>
          ${extensionOptions}
        </select>
      </div>
      <textarea class="command-form-commands" placeholder="Script content..."
        rows="8">${existing ? escapeHtml(existing.content) : ''}</textarea>
      <div class="command-form-actions">
        <button class="command-form-save">${isEdit ? 'Update' : 'Create'}</button>
        <button class="command-form-cancel">Cancel</button>
      </div>
    </div>`;

  const nameInput = container.querySelector('.command-form-name') as HTMLInputElement;
  const extSelect = container.querySelector('.command-form-ext') as HTMLSelectElement;
  const contentArea = container.querySelector('.command-form-commands') as HTMLTextAreaElement;

  container.querySelector('.command-form-save')?.addEventListener('click', () => {
    const name = nameInput.value.trim();
    const extension = extSelect.value;
    const content = contentArea.value;
    if (!name || !content.trim()) return;
    onSave?.({ name, extension, content });
  });

  container.querySelector('.command-form-cancel')?.addEventListener('click', () => {
    onCancel?.();
  });

  if (isEdit) {
    contentArea.focus();
  } else {
    nameInput.focus();
  }
}
