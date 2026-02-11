/**
 * Command Form
 *
 * Inline create/edit form for commands.
 */

import { escapeHtml } from '../../utils';
import type { CommandDefinition } from './commandsApi';

export interface CommandFormData {
  name: string;
  description: string;
  commands: string[];
}

export function createCommandForm(
  container: HTMLElement,
  existing?: CommandDefinition,
  onSave?: (data: CommandFormData) => void,
  onCancel?: () => void,
): void {
  const isEdit = !!existing;

  container.innerHTML = `
    <div class="command-form">
      <input class="command-form-name" type="text" placeholder="Command name"
        value="${existing ? escapeHtml(existing.name) : ''}" />
      <input class="command-form-desc" type="text" placeholder="Description"
        value="${existing ? escapeHtml(existing.description) : ''}" />
      <textarea class="command-form-commands" placeholder="Shell commands (one per line)..."
        rows="4">${existing ? escapeHtml(existing.commands.join('\n')) : ''}</textarea>
      <div class="command-form-actions">
        <button class="command-form-save">${isEdit ? 'Update' : 'Create'}</button>
        <button class="command-form-cancel">Cancel</button>
      </div>
    </div>`;

  const nameInput = container.querySelector('.command-form-name') as HTMLInputElement;
  const descInput = container.querySelector('.command-form-desc') as HTMLInputElement;
  const commandsArea = container.querySelector('.command-form-commands') as HTMLTextAreaElement;

  container.querySelector('.command-form-save')?.addEventListener('click', () => {
    const name = nameInput.value.trim();
    const description = descInput.value.trim();
    const commands = commandsArea.value.split('\n').filter((l) => l.trim());
    if (!name || commands.length === 0) return;
    onSave?.({ name, description, commands });
  });

  container.querySelector('.command-form-cancel')?.addEventListener('click', () => {
    onCancel?.();
  });

  nameInput.focus();
}
