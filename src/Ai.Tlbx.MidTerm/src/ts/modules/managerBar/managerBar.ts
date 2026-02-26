/**
 * Manager Bar Module
 *
 * Renders customizable quick-action buttons below the terminal area.
 * Clicking a button sends its text + Enter to the active terminal.
 */

import { $currentSettings, $activeSessionId } from '../../stores';
import { sendInput } from '../comms';
import { updateSettings } from '../../api/client';
import { t } from '../i18n';
import { createLogger } from '../logging';

const log = createLogger('managerBar');

interface ManagerButton {
  id: string;
  label: string;
  text: string;
}

let barEl: HTMLElement | null = null;
let buttonsEl: HTMLElement | null = null;
let addBtn: HTMLElement | null = null;
let mobileDropdown: HTMLElement | null = null;

export function sendCommand(sessionId: string, text: string): void {
  sendInput(sessionId, text);
  setTimeout(() => sendInput(sessionId, '\r'), 200);
}

export function initManagerBar(): void {
  barEl = document.getElementById('manager-bar');
  buttonsEl = document.getElementById('manager-bar-buttons');
  addBtn = document.getElementById('manager-bar-add');
  mobileDropdown = document.getElementById('mobile-actions-dropdown');
  if (!barEl || !buttonsEl || !addBtn) return;

  $currentSettings.subscribe((settings) => {
    if (!settings) return;
    renderButtons(settings.managerBarButtons ?? []);
    barEl!.classList.toggle('hidden', !settings.managerBarEnabled);
    renderMobileButtons(settings.managerBarEnabled ? (settings.managerBarButtons ?? []) : []);
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

  if (mobileDropdown) {
    mobileDropdown.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const mobileBtn = target.closest('.mobile-manager-item') as HTMLElement | null;
      if (!mobileBtn) return;

      const managerId = mobileBtn.dataset.managerId;
      if (!managerId) return;

      const settings = $currentSettings.get();
      const buttons: ManagerButton[] = settings?.managerBarButtons ?? [];
      const btn = buttons.find((b) => b.id === managerId);
      if (!btn) return;

      const activeId = $activeSessionId.get();
      if (activeId) {
        const text = btn.text.replace(/[\r\n]+$/, '');
        sendCommand(activeId, text);
      }
    });
  }
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
      `<button class="manager-btn-edit" title="${t('managerBar.edit')}"><span class="icon">\ue91f</span></button>` +
      `<button class="manager-btn-delete" title="${t('managerBar.remove')}"><span class="icon">\ue909</span></button>` +
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
    const text = btn.text.replace(/[\r\n]+$/, '');
    sendCommand(activeId, text);
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
  input.placeholder = t('managerBar.labelHint');
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
  >[0])
    .then(({ response }) => {
      if (!response.ok) {
        log.error(() => `Failed to save manager bar buttons: ${response.status}`);
      }
    })
    .catch((e) => {
      log.error(() => `Failed to save manager bar buttons: ${String(e)}`);
    });
}

function renderMobileButtons(buttons: ManagerButton[]): void {
  if (!mobileDropdown) return;

  mobileDropdown
    .querySelectorAll('.mobile-manager-item, .mobile-manager-separator')
    .forEach((el) => el.remove());

  if (buttons.length === 0) return;

  const sep = document.createElement('div');
  sep.className = 'mobile-manager-separator';
  mobileDropdown.appendChild(sep);

  for (const btn of buttons) {
    const button = document.createElement('button');
    button.className = 'mobile-actions-item topbar-action mobile-manager-item';
    button.dataset.managerId = btn.id;
    button.innerHTML =
      `<span class="mobile-actions-symbol">\u25B6</span>` +
      `<span class="mobile-actions-label">${escapeHtml(btn.label)}</span>`;
    mobileDropdown.appendChild(button);
  }
}

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
