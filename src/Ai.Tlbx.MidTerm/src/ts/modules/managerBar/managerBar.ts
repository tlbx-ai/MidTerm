/**
 * Manager Bar Module
 *
 * Renders customizable quick-action buttons below the terminal area.
 * Buttons can execute immediately or queue richer workflows against the
 * session that was active when the action was triggered.
 */

import { $activeSessionId, $currentSettings, $managerBarQueue } from '../../stores';
import { updateSettings } from '../../api/client';
import { icon } from '../../constants';
import type { ManagerBarQueueEntry } from '../../types';
import { submitSessionText } from '../input/submit';
import { t } from '../i18n';
import { createLogger } from '../logging';
import { registerBackButtonLayer } from '../navigation/backButtonGuard';
import {
  createDefaultManagerButton,
  formatPromptPreview,
  isImmediateManagerAction,
  normalizeManagerBarButton,
  normalizeManagerBarButtons,
  type ManagerActionType,
  type ManagerBarScheduleEntry,
  type ManagerButton,
  type ManagerRepeatUnit,
  type ManagerScheduleRepeat,
  type ManagerTriggerKind,
  type NormalizedManagerButton,
} from './workflow';
import { shouldShowManagerBar } from './visibility';

const log = createLogger('managerBar');
const QUEUE_ENQUEUE_DEDUP_WINDOW_MS = 1500;

let barEl: HTMLElement | null = null;
let queueEl: HTMLElement | null = null;
let buttonsEl: HTMLElement | null = null;
let addBtn: HTMLElement | null = null;
let mobileDropdown: HTMLElement | null = null;

let modalEl: HTMLElement | null = null;
let modalBackdrop: HTMLElement | null = null;
let modalCloseBtn: HTMLElement | null = null;
let modalCancelBtn: HTMLElement | null = null;
let modalSaveBtn: HTMLElement | null = null;
let modalTitleEl: HTMLElement | null = null;
let modalErrorEl: HTMLElement | null = null;
let labelInput: HTMLInputElement | null = null;
let typeSelect: HTMLSelectElement | null = null;
let triggerSelect: HTMLSelectElement | null = null;
let promptsTitleEl: HTMLElement | null = null;
let promptsCopyEl: HTMLElement | null = null;
let typeDescriptionEl: HTMLElement | null = null;
let triggerDescriptionEl: HTMLElement | null = null;
let promptsContainer: HTMLElement | null = null;
let addPromptBtn: HTMLButtonElement | null = null;
let repeatCountInput: HTMLInputElement | null = null;
let repeatEveryValueInput: HTMLInputElement | null = null;
let repeatEveryUnitSelect: HTMLSelectElement | null = null;
let scheduleContainer: HTMLElement | null = null;
let addScheduleBtn: HTMLButtonElement | null = null;
let cooldownHintEl: HTMLElement | null = null;
let chainHintEl: HTMLElement | null = null;
let triggerDetailsEl: HTMLElement | null = null;
let repeatCountGroupEl: HTMLElement | null = null;
let repeatIntervalGroupEl: HTMLElement | null = null;
let scheduleGroupEl: HTMLElement | null = null;

let editingActionId: string | null = null;
let renderedButtons: NormalizedManagerButton[] = [];
let queueEntries: ManagerBarQueueEntry[] = [];
let releaseBackButtonLayer: (() => void) | null = null;
const pendingEnqueueGuards = new Map<string, number>();
const pendingQueueRemovals = new Set<string>();

export function sendCommand(sessionId: string, text: string): void {
  void submitSessionText(sessionId, text).catch((error: unknown) => {
    log.error(() => `Failed to submit manager bar command: ${String(error)}`);
  });
}

export function initManagerBar(): void {
  barEl = document.getElementById('manager-bar');
  queueEl = document.getElementById('manager-bar-queue');
  buttonsEl = document.getElementById('manager-bar-buttons');
  addBtn = document.getElementById('manager-bar-add');
  mobileDropdown = document.getElementById('mobile-actions-dropdown');

  modalEl = document.getElementById('manager-action-modal');
  modalBackdrop = modalEl?.querySelector('.modal-backdrop') ?? null;
  modalCloseBtn = document.getElementById('btn-close-manager-action');
  modalCancelBtn = document.getElementById('btn-cancel-manager-action');
  modalSaveBtn = document.getElementById('btn-save-manager-action');
  modalTitleEl = document.getElementById('manager-action-modal-title');
  modalErrorEl = document.getElementById('manager-action-error');
  labelInput = document.getElementById('manager-action-label') as HTMLInputElement | null;
  typeSelect = document.getElementById('manager-action-type') as HTMLSelectElement | null;
  triggerSelect = document.getElementById('manager-action-trigger') as HTMLSelectElement | null;
  promptsTitleEl = document.getElementById('manager-action-prompts-title');
  promptsCopyEl = document.getElementById('manager-action-prompts-copy');
  typeDescriptionEl = document.getElementById('manager-action-type-description');
  triggerDescriptionEl = document.getElementById('manager-action-trigger-description');
  promptsContainer = document.getElementById('manager-action-prompts');
  addPromptBtn = document.getElementById('manager-action-add-prompt') as HTMLButtonElement | null;
  repeatCountInput = document.getElementById(
    'manager-action-repeat-count',
  ) as HTMLInputElement | null;
  repeatEveryValueInput = document.getElementById(
    'manager-action-repeat-every-value',
  ) as HTMLInputElement | null;
  repeatEveryUnitSelect = document.getElementById(
    'manager-action-repeat-every-unit',
  ) as HTMLSelectElement | null;
  scheduleContainer = document.getElementById('manager-action-schedule-list');
  addScheduleBtn = document.getElementById(
    'manager-action-add-schedule',
  ) as HTMLButtonElement | null;
  cooldownHintEl = document.getElementById('manager-action-cooldown-hint');
  chainHintEl = document.getElementById('manager-action-chain-hint');
  triggerDetailsEl = document.getElementById('manager-action-trigger-details');
  repeatCountGroupEl = document.getElementById('manager-action-repeat-count-group');
  repeatIntervalGroupEl = document.getElementById('manager-action-repeat-interval-group');
  scheduleGroupEl = document.getElementById('manager-action-schedule-group');

  if (!barEl || !buttonsEl || !addBtn || !queueEl) return;

  const syncManagerBarVisibility = (): void => {
    const settings = $currentSettings.get();
    const visible = shouldShowManagerBar(settings?.managerBarEnabled, $activeSessionId.get());
    barEl?.classList.toggle('hidden', !visible);
    renderMobileButtons(visible ? renderedButtons : []);
    renderQueue();
  };

  $currentSettings.subscribe((settings) => {
    if (!settings) return;
    renderedButtons = normalizeManagerBarButtons(
      settings.managerBarButtons as unknown as ManagerButton[],
    );
    renderButtons(renderedButtons);
    syncManagerBarVisibility();
  });

  $activeSessionId.subscribe(() => {
    syncManagerBarVisibility();
  });

  $managerBarQueue.subscribe((entries) => {
    queueEntries = [...entries];
    const liveQueueIds = new Set(entries.map((entry) => entry.queueId));
    for (const queueId of pendingQueueRemovals) {
      if (!liveQueueIds.has(queueId)) {
        pendingQueueRemovals.delete(queueId);
      }
    }
    syncManagerBarVisibility();
  });

  buttonsEl.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;

    const menuBtn = target.closest<HTMLButtonElement>('.manager-btn-menu');
    if (menuBtn) {
      event.stopPropagation();
      const button = menuBtn.closest<HTMLElement>('.manager-btn');
      if (button) {
        const shouldOpen = !button.classList.contains('menu-open');
        closeOpenManagerMenus();
        button.classList.toggle('menu-open', shouldOpen);
        menuBtn.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
      }
      return;
    }

    const editBtn = target.closest('.manager-btn-edit');
    if (editBtn) {
      const button = editBtn.closest<HTMLElement>('.manager-btn');
      if (button?.dataset.id) {
        closeOpenManagerMenus();
        const action = renderedButtons.find((entry) => entry.id === button.dataset.id);
        if (action) openActionModal(action);
      }
      return;
    }

    const deleteBtn = target.closest('.manager-btn-delete');
    if (deleteBtn) {
      const button = deleteBtn.closest<HTMLElement>('.manager-btn');
      if (button?.dataset.id) {
        closeOpenManagerMenus();
        deleteButton(button.dataset.id);
      }
      return;
    }

    if (target.closest('.manager-btn-actions')) {
      return;
    }

    const button = target.closest<HTMLElement>('.manager-btn');
    if (button) {
      closeOpenManagerMenus();
      if (button.dataset.id) runButton(button.dataset.id);
    }
  });

  document.addEventListener('click', handleDocumentClickForManagerMenu);

  addBtn.addEventListener('click', () => {
    closeOpenManagerMenus();
    openActionModal();
  });

  if (mobileDropdown) {
    mobileDropdown.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      const mobileBtn = target?.closest<HTMLElement>('.mobile-manager-item');
      if (!mobileBtn?.dataset.managerId) return;
      runButton(mobileBtn.dataset.managerId);
    });
  }

  bindModalEvents();
}

function bindModalEvents(): void {
  modalCloseBtn?.addEventListener('click', closeActionModal);
  modalCancelBtn?.addEventListener('click', closeActionModal);
  modalBackdrop?.addEventListener('click', closeActionModal);
  modalSaveBtn?.addEventListener('click', saveModalAction);

  typeSelect?.addEventListener('change', () => {
    const prompts = readPromptValues();
    renderPromptEditors(
      typeSelect?.value === 'chain' ? Math.max(prompts.length, 1) : 1,
      prompts,
      typeSelect?.value === 'chain' ? 'chain' : 'single',
    );
    syncModalSections();
  });

  triggerSelect?.addEventListener('change', syncModalSections);

  addPromptBtn?.addEventListener('click', () => {
    const prompts = readPromptValues();
    prompts.push('');
    renderPromptEditors(prompts.length, prompts, getModalActionType());
    focusPrimaryPrompt(prompts.length - 1);
  });

  addScheduleBtn?.addEventListener('click', () => {
    const schedule = readScheduleValues();
    schedule.push({ timeOfDay: '09:00', repeat: 'daily' });
    renderScheduleEditors(schedule);
    focusNewestScheduleTime();
  });

  scheduleContainer?.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const removeBtn = target?.closest<HTMLButtonElement>('.manager-action-schedule-remove');
    if (!removeBtn) return;

    const index = Number.parseInt(removeBtn.dataset.index ?? '-1', 10);
    if (!Number.isInteger(index) || index < 0) return;

    const schedule = readScheduleValues();
    schedule.splice(index, 1);
    renderScheduleEditors(schedule);
  });

  promptsContainer?.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const removeBtn = target?.closest<HTMLButtonElement>('.manager-action-prompt-remove');
    if (!removeBtn) return;

    const index = Number.parseInt(removeBtn.dataset.index ?? '-1', 10);
    if (!Number.isInteger(index) || index < 0) return;

    const prompts = readPromptValues();
    prompts.splice(index, 1);
    renderPromptEditors(Math.max(prompts.length, 1), prompts, getModalActionType());
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (closeOpenManagerMenus()) return;
    if (!modalEl || modalEl.classList.contains('hidden')) return;
    closeActionModal();
  });
}

function renderButtons(buttons: NormalizedManagerButton[]): void {
  if (!buttonsEl) return;

  buttonsEl.innerHTML = '';
  for (const button of buttons) {
    const wrapper = document.createElement('span');
    wrapper.className = 'manager-btn';
    wrapper.dataset.id = button.id;
    wrapper.innerHTML =
      `<span class="manager-btn-label">${escapeHtml(button.label)}</span>` +
      `<button class="manager-btn-menu" title="${escapeHtml(t('session.actions'))}" aria-label="${escapeHtml(t('session.actions'))}" aria-haspopup="menu" aria-expanded="false" type="button">${icon('menu')}</button>` +
      `<span class="manager-btn-actions">` +
      `<button class="manager-btn-edit" title="${escapeHtml(t('managerBar.edit'))}" aria-label="${escapeHtml(t('managerBar.edit'))}" role="menuitem" type="button"><span class="icon">\ue91f</span><span class="manager-btn-action-label">${escapeHtml(t('managerBar.edit'))}</span></button>` +
      `<button class="manager-btn-delete" title="${escapeHtml(t('managerBar.remove'))}" aria-label="${escapeHtml(t('managerBar.remove'))}" role="menuitem" type="button"><span class="icon">\ue909</span><span class="manager-btn-action-label">${escapeHtml(t('managerBar.remove'))}</span></button>` +
      `</span>`;
    buttonsEl.appendChild(wrapper);
  }
}

function handleDocumentClickForManagerMenu(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  if (target?.closest('.manager-btn')) {
    return;
  }

  closeOpenManagerMenus();
}

function closeOpenManagerMenus(): boolean {
  if (!buttonsEl) return false;

  let closedAny = false;
  buttonsEl.querySelectorAll<HTMLElement>('.manager-btn.menu-open').forEach((button) => {
    button.classList.remove('menu-open');
    closedAny = true;
  });
  buttonsEl
    .querySelectorAll<HTMLButtonElement>('.manager-btn-menu[aria-expanded="true"]')
    .forEach((button) => {
      button.setAttribute('aria-expanded', 'false');
    });

  return closedAny;
}

function renderMobileButtons(buttons: NormalizedManagerButton[]): void {
  if (!mobileDropdown) return;

  mobileDropdown
    .querySelectorAll('.mobile-manager-item, .mobile-manager-separator')
    .forEach((element) => {
      element.remove();
    });

  if (buttons.length === 0) return;

  const separator = document.createElement('div');
  separator.className = 'mobile-manager-separator';
  mobileDropdown.appendChild(separator);

  for (const button of buttons) {
    const item = document.createElement('button');
    item.className = 'mobile-actions-item topbar-action mobile-manager-item';
    item.dataset.managerId = button.id;
    item.innerHTML =
      `<span class="mobile-actions-symbol">\u25B6</span>` +
      `<span class="mobile-actions-label">${escapeHtml(button.label)}</span>`;
    mobileDropdown.appendChild(item);
  }
}

function renderQueue(): void {
  if (!queueEl) return;

  const settings = $currentSettings.get();
  const activeSessionId = $activeSessionId.get();
  const visibleQueue =
    settings?.managerBarEnabled && activeSessionId
      ? queueEntries
          .filter((entry) => entry.sessionId === activeSessionId)
          .filter((entry) => !pendingQueueRemovals.has(entry.queueId))
      : [];

  queueEl.innerHTML = '';
  queueEl.classList.toggle('hidden', visibleQueue.length === 0);
  if (visibleQueue.length === 0) return;

  for (const entry of visibleQueue) {
    const item = document.createElement('div');
    item.className = 'manager-queue-item';
    item.dataset.queueId = entry.queueId;

    const title = document.createElement('div');
    title.className = 'manager-queue-title';
    title.textContent = describeQueueTitle(entry);

    const condition = document.createElement('div');
    condition.className = 'manager-queue-condition';
    condition.textContent = describeQueueCondition(entry);

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'manager-queue-delete';
    deleteBtn.dataset.queueId = entry.queueId;
    deleteBtn.title = t('managerBar.queue.dequeue');
    deleteBtn.setAttribute('aria-label', t('managerBar.queue.dequeue'));
    deleteBtn.innerHTML = '<span class="icon">\ue909</span>';
    deleteBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void removeQueueEntry(entry.queueId);
    });

    item.appendChild(title);
    item.appendChild(condition);
    item.appendChild(deleteBtn);
    queueEl.appendChild(item);
  }
}

function describeQueueTitle(entry: ManagerBarQueueEntry): string {
  const action = entry.action;
  if (action.actionType === 'chain') {
    const step = Math.min(action.prompts.length, entry.nextPromptIndex + 1);
    return `${action.label} (${step}/${action.prompts.length})`;
  }

  if (action.trigger.kind === 'repeatCount') {
    return `${action.label} (${entry.completedCycles + 1}/${action.trigger.repeatCount})`;
  }

  return action.label || formatPromptPreview(action.prompts[0] ?? '');
}

function describeQueueCondition(entry: ManagerBarQueueEntry): string {
  if (entry.phase === 'chainCooldown') {
    return t('managerBar.queue.chainCooldown');
  }
  if (entry.phase === 'pendingCooldown') {
    return t('managerBar.queue.cooldown');
  }

  const trigger = entry.action.trigger;
  if (trigger.kind === 'repeatCount') {
    const remaining = Math.max(0, trigger.repeatCount - entry.completedCycles);
    return `${t('managerBar.queue.repeatCountPrefix')} ${remaining}${t('managerBar.queue.repeatCountSuffix')}`;
  }
  if (trigger.kind === 'repeatInterval') {
    return `${t('managerBar.queue.every')} ${trigger.repeatEveryValue} ${t(
      `managerBar.intervalUnit.${trigger.repeatEveryUnit}`,
    )}`;
  }
  if (trigger.kind === 'schedule') {
    return trigger.schedule
      .map(
        (schedule) => `${t(`managerBar.scheduleRepeat.${schedule.repeat}`)} ${schedule.timeOfDay}`,
      )
      .join(' • ');
  }
  if (trigger.kind === 'fireAndForget' && entry.action.actionType === 'chain') {
    return t('managerBar.queue.chainRunning');
  }
  return t('managerBar.queue.cooldown');
}

function openActionModal(existing?: NormalizedManagerButton): void {
  if (
    !modalEl ||
    !modalTitleEl ||
    !labelInput ||
    !typeSelect ||
    !triggerSelect ||
    !repeatCountInput ||
    !repeatEveryValueInput ||
    !repeatEveryUnitSelect
  ) {
    return;
  }

  const action = existing ?? createDefaultManagerButton();
  editingActionId = existing?.id ?? null;
  clearModalError();

  modalTitleEl.textContent = existing
    ? t('managerBar.modal.editTitle')
    : t('managerBar.modal.title');
  labelInput.value = action.label;
  typeSelect.value = action.actionType;
  triggerSelect.value = action.trigger.kind;
  repeatCountInput.value = String(action.trigger.repeatCount);
  repeatEveryValueInput.value = String(action.trigger.repeatEveryValue);
  repeatEveryUnitSelect.value = action.trigger.repeatEveryUnit;

  renderPromptEditors(
    action.actionType === 'chain' ? Math.max(action.prompts.length, 1) : 1,
    action.prompts,
    action.actionType,
  );
  renderScheduleEditors(action.trigger.schedule);
  syncModalSections();

  if (!releaseBackButtonLayer) {
    releaseBackButtonLayer = registerBackButtonLayer(closeActionModal);
  }

  modalEl.classList.remove('hidden');
  const modalBody = modalEl.querySelector<HTMLElement>('.manager-action-modal-body');
  if (modalBody) {
    modalBody.scrollTop = 0;
  }
  focusPrimaryPrompt();
}

function closeActionModal(): void {
  releaseBackButtonLayer?.();
  releaseBackButtonLayer = null;
  editingActionId = null;
  modalEl?.classList.add('hidden');
  clearModalError();
}

function saveModalAction(): void {
  const settings = $currentSettings.get();
  if (!settings) return;

  const actionType = getModalActionType();
  const prompts = readPromptValues();
  if (prompts.length === 0 || prompts.every((prompt) => prompt.trim().length === 0)) {
    showModalError(t('managerBar.modal.errorPromptRequired'));
    return;
  }

  const triggerKind = getModalTriggerKind();
  const schedule = readScheduleValues();
  if (triggerKind === 'schedule' && schedule.length === 0) {
    showModalError(t('managerBar.modal.errorScheduleRequired'));
    return;
  }

  const action = normalizeManagerBarButton({
    id: editingActionId ?? generateActionId(),
    label: labelInput?.value ?? '',
    text: prompts[0] ?? '',
    actionType,
    prompts,
    trigger: {
      kind: triggerKind,
      repeatCount: Number.parseInt(repeatCountInput?.value ?? '1', 10),
      repeatEveryValue: Number.parseInt(repeatEveryValueInput?.value ?? '1', 10),
      repeatEveryUnit: (repeatEveryUnitSelect?.value ?? 'minutes') as ManagerRepeatUnit,
      schedule,
    },
  });

  const currentButtons = normalizeManagerBarButtons(
    settings.managerBarButtons as unknown as ManagerButton[],
  );
  const nextButtons = [...currentButtons];
  const index = editingActionId
    ? nextButtons.findIndex((button) => button.id === editingActionId)
    : -1;
  if (index >= 0) {
    nextButtons[index] = action;
  } else {
    nextButtons.push(action);
  }

  saveButtons(nextButtons);
  closeActionModal();
}

function renderPromptEditors(count: number, values: string[], actionType: ManagerActionType): void {
  if (!promptsContainer || !addPromptBtn) return;

  promptsContainer.innerHTML = '';
  addPromptBtn.classList.toggle('hidden', actionType !== 'chain');

  const rows = Math.max(count, 1);
  for (let index = 0; index < rows; index += 1) {
    const row = document.createElement('div');
    row.className = `manager-action-prompt-row manager-action-prompt-row-${actionType}`;

    const header = document.createElement('div');
    header.className = 'manager-action-prompt-header';

    const label = document.createElement('span');
    label.className = 'manager-action-prompt-label';
    label.textContent =
      actionType === 'chain'
        ? `${t('managerBar.modal.chainPrompt')} ${index + 1}`
        : t('managerBar.modal.singlePrompt');
    header.appendChild(label);

    if (actionType === 'chain' && rows > 1) {
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'btn-secondary manager-action-prompt-remove';
      removeBtn.dataset.index = String(index);
      removeBtn.textContent = t('managerBar.modal.removePrompt');
      header.appendChild(removeBtn);
    }

    const textarea = document.createElement('textarea');
    textarea.className = 'manager-action-prompt-input';
    textarea.rows = actionType === 'chain' ? 3 : 7;
    textarea.value = values[index] ?? '';
    textarea.placeholder = t('managerBar.modal.promptPlaceholder');

    row.appendChild(header);
    row.appendChild(textarea);
    promptsContainer.appendChild(row);
  }
}

function renderScheduleEditors(schedule: ManagerBarScheduleEntry[]): void {
  const container = scheduleContainer;
  if (!container) return;

  const rows = schedule.length > 0 ? schedule : [{ timeOfDay: '09:00', repeat: 'daily' }];
  container.innerHTML = '';

  rows.forEach((entry, index) => {
    const row = document.createElement('div');
    row.className = 'manager-action-schedule-row';

    const timeInput = document.createElement('input');
    timeInput.type = 'time';
    timeInput.className = 'manager-action-schedule-time';
    timeInput.value = entry.timeOfDay;

    const repeatSelect = document.createElement('select');
    repeatSelect.className = 'manager-action-schedule-repeat';
    repeatSelect.innerHTML = [
      { value: 'daily', label: t('managerBar.scheduleRepeat.daily') },
      { value: 'weekdays', label: t('managerBar.scheduleRepeat.weekdays') },
      { value: 'weekends', label: t('managerBar.scheduleRepeat.weekends') },
    ]
      .map(
        (option) =>
          `<option value="${option.value}" ${option.value === entry.repeat ? 'selected' : ''}>${escapeHtml(option.label)}</option>`,
      )
      .join('');

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn-secondary manager-action-schedule-remove';
    removeBtn.dataset.index = String(index);
    removeBtn.textContent = t('managerBar.modal.removeSchedule');

    row.appendChild(timeInput);
    row.appendChild(repeatSelect);
    row.appendChild(removeBtn);
    container.appendChild(row);
  });
}

function syncModalSections(): void {
  const actionType = getModalActionType();
  const triggerKind = getModalTriggerKind();

  if (promptsTitleEl) {
    promptsTitleEl.textContent = t(
      actionType === 'chain'
        ? 'managerBar.modal.promptSectionChain'
        : 'managerBar.modal.promptSectionSingle',
    );
  }
  if (promptsCopyEl) {
    promptsCopyEl.textContent = t(
      actionType === 'chain'
        ? 'managerBar.modal.promptSectionChainCopy'
        : 'managerBar.modal.promptSectionSingleCopy',
    );
  }
  if (typeDescriptionEl) {
    typeDescriptionEl.textContent = t(
      actionType === 'chain'
        ? 'managerBar.modal.typeChainDescription'
        : 'managerBar.modal.typeSingleDescription',
    );
  }
  if (triggerDescriptionEl) {
    triggerDescriptionEl.textContent = t(`managerBar.modal.triggerDescription.${triggerKind}`);
  }

  cooldownHintEl?.classList.toggle('hidden', triggerKind !== 'onCooldown');
  chainHintEl?.classList.toggle('hidden', actionType !== 'chain');
  triggerDetailsEl?.classList.toggle('hidden', triggerKind === 'fireAndForget');
  repeatCountGroupEl?.classList.toggle('hidden', triggerKind !== 'repeatCount');
  repeatIntervalGroupEl?.classList.toggle('hidden', triggerKind !== 'repeatInterval');
  scheduleGroupEl?.classList.toggle('hidden', triggerKind !== 'schedule');
}

function readPromptValues(): string[] {
  if (!promptsContainer) return [];
  return [...promptsContainer.querySelectorAll<HTMLTextAreaElement>('.manager-action-prompt-input')]
    .map((input) => input.value)
    .filter((_prompt, index) => getModalActionType() === 'chain' || index === 0);
}

function readScheduleValues(): ManagerBarScheduleEntry[] {
  if (!scheduleContainer) return [];
  const rows = [...scheduleContainer.querySelectorAll<HTMLElement>('.manager-action-schedule-row')];
  return rows
    .map((row) => {
      const timeInput = row.querySelector<HTMLInputElement>('.manager-action-schedule-time');
      const repeatSelect = row.querySelector<HTMLSelectElement>('.manager-action-schedule-repeat');
      if (!timeInput || !repeatSelect || !timeInput.value) return null;
      return {
        timeOfDay: timeInput.value,
        repeat: repeatSelect.value as ManagerScheduleRepeat,
      };
    })
    .filter((entry): entry is ManagerBarScheduleEntry => entry !== null);
}

function deleteButton(id: string): void {
  const settings = $currentSettings.get();
  if (!settings) return;

  const nextButtons = normalizeManagerBarButtons(
    settings.managerBarButtons as unknown as ManagerButton[],
  ).filter((button) => button.id !== id);
  saveButtons(nextButtons);
}

function saveButtons(buttons: NormalizedManagerButton[]): void {
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
    .catch((error: unknown) => {
      log.error(() => `Failed to save manager bar buttons: ${String(error)}`);
    });
}

function runButton(id: string): void {
  const action = renderedButtons.find((button) => button.id === id);
  const sessionId = $activeSessionId.get();
  if (!action || !sessionId) return;

  if (isImmediateManagerAction(action)) {
    sendCommand(sessionId, action.prompts[0] ?? '');
    return;
  }

  void enqueueAction(sessionId, action);
}

async function enqueueAction(sessionId: string, action: NormalizedManagerButton): Promise<void> {
  const now = Date.now();
  pruneExpiredEnqueueGuards(now);
  const enqueueGuardKey = buildEnqueueGuardKey(sessionId, action);
  const blockedUntil = pendingEnqueueGuards.get(enqueueGuardKey) ?? 0;
  if (blockedUntil > now) {
    return;
  }

  pendingEnqueueGuards.set(enqueueGuardKey, now + QUEUE_ENQUEUE_DEDUP_WINDOW_MS);

  try {
    const response = await fetch('/api/manager-bar/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, action }),
    });
    if (!response.ok) {
      log.error(() => `Failed to enqueue manager bar action: ${response.status}`);
    }
  } catch (error) {
    log.error(() => `Failed to enqueue manager bar action: ${String(error)}`);
  }
}

function buildEnqueueGuardKey(sessionId: string, action: NormalizedManagerButton): string {
  return [
    sessionId,
    action.id,
    action.actionType,
    action.trigger.kind,
    action.prompts.join('\u001f'),
  ].join('\u001d');
}

function pruneExpiredEnqueueGuards(now: number): void {
  for (const [key, expiresAt] of pendingEnqueueGuards.entries()) {
    if (expiresAt <= now) {
      pendingEnqueueGuards.delete(key);
    }
  }
}

async function removeQueueEntry(queueId: string): Promise<void> {
  if (pendingQueueRemovals.has(queueId)) {
    return;
  }

  pendingQueueRemovals.add(queueId);
  renderQueue();

  try {
    const response = await fetch(`/api/manager-bar/queue/${encodeURIComponent(queueId)}`, {
      method: 'DELETE',
    });
    if (!response.ok && response.status !== 404) {
      pendingQueueRemovals.delete(queueId);
      renderQueue();
      log.error(() => `Failed to dequeue manager bar action: ${response.status}`);
      return;
    }

    queueEntries = queueEntries.filter((entry) => entry.queueId !== queueId);
    pendingQueueRemovals.delete(queueId);
    renderQueue();
  } catch (error) {
    pendingQueueRemovals.delete(queueId);
    renderQueue();
    log.error(() => `Failed to dequeue manager bar action: ${String(error)}`);
  }
}

function getModalActionType(): ManagerActionType {
  return typeSelect?.value === 'chain' ? 'chain' : 'single';
}

function getModalTriggerKind(): ManagerTriggerKind {
  const trigger = triggerSelect?.value as ManagerTriggerKind | undefined;
  if (
    trigger === 'onCooldown' ||
    trigger === 'repeatCount' ||
    trigger === 'repeatInterval' ||
    trigger === 'schedule'
  ) {
    return trigger;
  }
  return 'fireAndForget';
}

function showModalError(message: string): void {
  if (!modalErrorEl) return;
  modalErrorEl.textContent = message;
  modalErrorEl.classList.remove('hidden');
}

function clearModalError(): void {
  if (!modalErrorEl) return;
  modalErrorEl.textContent = '';
  modalErrorEl.classList.add('hidden');
}

function generateActionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `manager-action-${Date.now()}`;
}

function escapeHtml(value: string): string {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}

function focusPrimaryPrompt(index: number = 0): void {
  window.requestAnimationFrame(() => {
    const prompts = promptsContainer?.querySelectorAll<HTMLTextAreaElement>(
      '.manager-action-prompt-input',
    );
    const prompt = prompts?.[index] ?? prompts?.[0];
    if (!prompt) return;

    try {
      prompt.focus({ preventScroll: true });
    } catch {
      prompt.focus();
    }
    const cursor = prompt.value.length;
    prompt.setSelectionRange(cursor, cursor);
  });
}

function focusNewestScheduleTime(): void {
  window.requestAnimationFrame(() => {
    const times = scheduleContainer?.querySelectorAll<HTMLInputElement>(
      '.manager-action-schedule-time',
    );
    const input = times?.[times.length - 1];
    if (!input) return;

    input.focus();
  });
}
