/**
 * Manager Bar Module
 *
 * Renders customizable quick-action buttons below the terminal area.
 * Clicking a button sends its text + Enter to the active terminal.
 */

import { $currentSettings, $activeSessionId } from '../../stores';
import { sendInput } from '../comms';
import { updateSettings } from '../../api/client';

interface ManagerButton {
  id: string;
  label: string;
  text: string;
}

let barEl: HTMLElement | null = null;
let buttonsEl: HTMLElement | null = null;
let addBtn: HTMLElement | null = null;

export function initManagerBar(): void {
  barEl = document.getElementById('manager-bar');
  buttonsEl = document.getElementById('manager-bar-buttons');
  addBtn = document.getElementById('manager-bar-add');
  if (!barEl || !buttonsEl || !addBtn) return;

  $currentSettings.subscribe((settings) => {
    if (!settings) return;
    renderButtons(settings.managerBarButtons ?? []);
    barEl!.classList.toggle('hidden', !settings.managerBarEnabled);
  });

  buttonsEl.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    const editBtn = target.closest('.manager-btn-edit') as HTMLElement | null;
    if (editBtn) {
      const btn = editBtn.closest('.manager-btn') as HTMLElement | null;
      if (btn) startInlineEdit(btn.dataset.id!);
      return;
    }

    const deleteBtn = target.closest('.manager-btn-delete') as HTMLElement | null;
    if (deleteBtn) {
      const btn = deleteBtn.closest('.manager-btn') as HTMLElement | null;
      if (btn) deleteButton(btn.dataset.id!);
      return;
    }

    const labelEl = target.closest('.manager-btn-label') as HTMLElement | null;
    if (labelEl) {
      const btn = labelEl.closest('.manager-btn') as HTMLElement | null;
      if (btn) clickButton(btn.dataset.id!);
    }
  });

  addBtn.addEventListener('click', startInlineAdd);
}

function renderButtons(buttons: ManagerButton[]): void {
  if (!buttonsEl) return;
  buttonsEl.innerHTML = '';
  for (const btn of buttons) {
    const span = document.createElement('span');
    span.className = 'manager-btn';
    span.dataset.id = btn.id;
    span.innerHTML =
      `<span class="manager-btn-label">${escapeHtml(btn.label)}</span>` +
      `<span class="manager-btn-actions">` +
      `<button class="manager-btn-edit" title="Edit"><span class="icon">\ue91f</span></button>` +
      `<button class="manager-btn-delete" title="Remove"><span class="icon">\ue909</span></button>` +
      `</span>`;
    buttonsEl.appendChild(span);
  }
}

function clickButton(id: string): void {
  const settings = $currentSettings.get();
  const buttons: ManagerButton[] = settings?.managerBarButtons ?? [];
  const btn = buttons.find((b) => b.id === id);
  if (!btn) return;

  const activeId = $activeSessionId.get();
  if (activeId) {
    sendInput(activeId, btn.text);
    setTimeout(() => sendInput(activeId, '\r'), 100);
  }
}

function startInlineEdit(id: string): void {
  const settings = $currentSettings.get();
  const existing = (settings?.managerBarButtons ?? []).find((b) => b.id === id);
  if (!existing || !buttonsEl) return;

  const btnEl = buttonsEl.querySelector(`[data-id="${id}"]`) as HTMLElement | null;
  if (!btnEl) return;

  const labelEl = btnEl.querySelector('.manager-btn-label') as HTMLElement | null;
  if (!labelEl) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'manager-btn-input';
  input.value = existing.label;

  let committed = false;
  function commit(): void {
    if (committed) return;
    committed = true;
    const val = input.value.trim();
    if (val) {
      const buttons = [...(settings?.managerBarButtons ?? [])];
      const idx = buttons.findIndex((b) => b.id === id);
      if (idx >= 0) {
        buttons[idx] = { id, label: val, text: val };
        saveButtons(buttons);
        return;
      }
    }
    renderButtons(settings?.managerBarButtons ?? []);
  }

  function cancel(): void {
    if (committed) return;
    committed = true;
    renderButtons(settings?.managerBarButtons ?? []);
  }

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  });

  labelEl.replaceWith(input);
  btnEl.querySelector('.manager-btn-actions')?.remove();
  input.focus();
  input.select();
}

function startInlineAdd(): void {
  if (!buttonsEl) return;

  const span = document.createElement('span');
  span.className = 'manager-btn';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'manager-btn-input';
  input.placeholder = 'label…';
  span.appendChild(input);
  buttonsEl.appendChild(span);

  const settings = $currentSettings.get();
  let committed = false;

  function commit(): void {
    if (committed) return;
    committed = true;
    const val = input.value.trim();
    if (val) {
      const buttons = [...(settings?.managerBarButtons ?? [])];
      const id = String(Date.now());
      buttons.push({ id, label: val, text: val });
      saveButtons(buttons);
    } else {
      span.remove();
    }
  }

  function cancel(): void {
    if (committed) return;
    committed = true;
    span.remove();
  }

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  });

  input.focus();
}

function deleteButton(id: string): void {
  const settings = $currentSettings.get();
  const buttons: ManagerButton[] = [...(settings?.managerBarButtons ?? [])];
  const filtered = buttons.filter((b) => b.id !== id);
  saveButtons(filtered);
}

function saveButtons(buttons: ManagerButton[]): void {
  const settings = $currentSettings.get();
  if (!settings) return;

  $currentSettings.set({ ...settings, managerBarButtons: buttons });

  updateSettings({ ...settings, managerBarButtons: buttons } as Parameters<
    typeof updateSettings
  >[0]).catch((e) => console.error('Failed to save manager bar buttons:', e));
}

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
