import { t } from '../i18n';

export type ToolKind = 'mic' | 'attach' | 'photo';

export const TOOL_ORDER: ToolKind[] = ['mic', 'attach', 'photo'];

export interface LensQuickSettingsOption {
  value: string;
  label: string;
}

export interface SmartInputDomRefs {
  attachInput: HTMLInputElement;
  composerExpandBtn: HTMLButtonElement;
  inlineToolHost: HTMLDivElement;
  inputRow: HTMLDivElement;
  lensAttachmentHost: HTMLDivElement;
  lensQuickSettingsActions: HTMLDivElement;
  lensEffortSelect: HTMLSelectElement;
  lensModelSelect: HTMLSelectElement;
  lensPermissionSelect: HTMLSelectElement;
  lensPlanSelect: HTMLSelectElement;
  lensQuickSettingsRow: HTMLDivElement;
  photoInput: HTMLInputElement;
  sendBtn: HTMLButtonElement;
  textarea: HTMLTextAreaElement;
  toolsPanel: HTMLDivElement;
  toolsStrip: HTMLDivElement;
  toolsToggleBtn: HTMLButtonElement;
}

interface CreateSmartInputDomArgs {
  createToolsStrip: () => HTMLDivElement;
  onAttachInputChange: (files: FileList) => void;
  onLensEffortChange: () => void;
  onLensModelChange: () => void;
  onLensPermissionChange: () => void;
  onLensPlanChange: () => void;
  onPhotoInputChange: (files: FileList) => void;
  onExpandToggleClick: (event: MouseEvent) => void;
  onSendClick: () => void;
  onSendDoubleClick: (event: MouseEvent) => void;
  onSendPointerDown: () => void;
  onSendPointerEnd: () => void;
  onTextareaBeforeInput: (event: InputEvent, textarea: HTMLTextAreaElement) => void;
  onTextareaCut: (event: ClipboardEvent, textarea: HTMLTextAreaElement) => void;
  onTextareaFocus: () => void;
  onTextareaInput: (textarea: HTMLTextAreaElement) => void;
  onTextareaKeydown: (event: KeyboardEvent, textarea: HTMLTextAreaElement) => void;
  onTextareaPaste: (event: ClipboardEvent) => void;
  onTextareaSelect: (textarea: HTMLTextAreaElement) => void;
  onToolsTogglePointerDown: (event: PointerEvent) => void;
  onToolsToggleClick: (event: MouseEvent) => void;
  resizeTextarea: (textarea: HTMLTextAreaElement) => void;
}

interface CreateToolButtonsStripArgs {
  canUseVoice: boolean;
  onAttachClick: (pinOnUse: boolean, event: MouseEvent) => void;
  onMicPointerCancel: () => void;
  onMicPointerDown: (pinOnUse: boolean, event: PointerEvent) => void;
  onMicPointerLeave: () => void;
  onMicPointerUp: () => void;
  onPhotoClick: (pinOnUse: boolean, event: MouseEvent) => void;
}

interface RenderTerminalStatusRowArgs {
  autoSendEnabled: boolean;
  footerStatusHost: HTMLDivElement;
}

interface CreateTerminalTouchToggleButtonArgs {
  expanded: boolean;
  onToggle: () => void;
}

export function createSmartInputDom(args: CreateSmartInputDomArgs): SmartInputDomRefs {
  const lensQuickSettingsRow = document.createElement('div');
  lensQuickSettingsRow.className = 'smart-input-lens-settings';
  lensQuickSettingsRow.hidden = true;

  const lensModelSelect = document.createElement('select');
  lensModelSelect.className = 'smart-input-lens-control';
  setLensQuickSettingsDropdownOptions(lensModelSelect, [{ value: '', label: 'Default model' }]);
  lensModelSelect.addEventListener('change', args.onLensModelChange);

  const lensEffortSelect = document.createElement('select');
  lensEffortSelect.className = 'smart-input-lens-control';
  for (const [value, label] of [
    ['', 'Default'],
    ['low', 'Low'],
    ['medium', 'Medium'],
    ['high', 'High'],
  ] as const) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    lensEffortSelect.appendChild(option);
  }
  lensEffortSelect.addEventListener('change', args.onLensEffortChange);

  const lensPlanSelect = document.createElement('select');
  lensPlanSelect.className = 'smart-input-lens-control';
  for (const [value, label] of [
    ['off', 'Plan off'],
    ['on', 'Plan on'],
  ] as const) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    lensPlanSelect.appendChild(option);
  }
  lensPlanSelect.addEventListener('change', args.onLensPlanChange);

  const lensPermissionSelect = document.createElement('select');
  lensPermissionSelect.className = 'smart-input-lens-control';
  for (const [value, label] of [
    ['manual', 'Manual'],
    ['auto', 'Auto'],
  ] as const) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    lensPermissionSelect.appendChild(option);
  }
  lensPermissionSelect.addEventListener('change', args.onLensPermissionChange);

  const lensModelDropdown = createLensQuickSettingsDropdown(lensModelSelect);
  lensModelDropdown.classList.add('smart-input-lens-model');
  lensQuickSettingsRow.appendChild(createLensQuickSettingsField('Model', lensModelDropdown));
  lensQuickSettingsRow.appendChild(
    createLensQuickSettingsField('Effort', createLensQuickSettingsDropdown(lensEffortSelect)),
  );
  lensQuickSettingsRow.appendChild(
    createLensQuickSettingsField('Plan', createLensQuickSettingsDropdown(lensPlanSelect)),
  );
  lensQuickSettingsRow.appendChild(
    createLensQuickSettingsField(
      'Permissions',
      createLensQuickSettingsDropdown(lensPermissionSelect),
    ),
  );

  const lensQuickSettingsActions = document.createElement('div');
  lensQuickSettingsActions.className = 'smart-input-lens-actions';
  lensQuickSettingsActions.hidden = true;
  lensQuickSettingsRow.appendChild(lensQuickSettingsActions);

  const inputRow = document.createElement('div');
  inputRow.className = 'smart-input-row';

  const editorHost = document.createElement('div');
  editorHost.className = 'smart-input-editor';

  const lensAttachmentHost = document.createElement('div');
  lensAttachmentHost.className = 'smart-input-attachments';
  lensAttachmentHost.hidden = true;

  const textareaShell = document.createElement('div');
  textareaShell.className = 'smart-input-textarea-shell';

  const textarea = document.createElement('textarea');
  textarea.className = 'smart-input-textarea';
  textarea.rows = 1;
  textarea.placeholder = t('smartInput.placeholder');
  args.resizeTextarea(textarea);
  textarea.addEventListener('beforeinput', (event) => {
    args.onTextareaBeforeInput(event, textarea);
  });
  textarea.addEventListener('cut', (event) => {
    args.onTextareaCut(event, textarea);
  });
  textarea.addEventListener('input', () => {
    args.onTextareaInput(textarea);
  });
  textarea.addEventListener('pointerdown', () => {
    if (document.activeElement !== textarea) {
      textarea.focus({ preventScroll: true });
    }
  });
  textarea.addEventListener('focus', args.onTextareaFocus);
  textarea.addEventListener('paste', args.onTextareaPaste);
  textarea.addEventListener('select', () => {
    args.onTextareaSelect(textarea);
  });
  textarea.addEventListener('keydown', (event) => {
    args.onTextareaKeydown(event, textarea);
  });

  const composerExpandBtn = document.createElement('button');
  composerExpandBtn.type = 'button';
  composerExpandBtn.className = 'smart-input-expand-toggle';
  composerExpandBtn.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  composerExpandBtn.addEventListener('click', args.onExpandToggleClick);
  syncSmartInputComposerExpandToggleState(composerExpandBtn, false);

  const sendBtn = document.createElement('button');
  sendBtn.type = 'button';
  sendBtn.className = 'smart-input-send-btn';
  sendBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="21" height="21" fill="currentColor" aria-hidden="true" focusable="false"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>';
  sendBtn.title = t('smartInput.sendGestureHint');
  sendBtn.setAttribute('aria-label', t('smartInput.send'));
  sendBtn.addEventListener('dblclick', args.onSendDoubleClick);
  sendBtn.addEventListener('pointerdown', args.onSendPointerDown);
  for (const eventName of ['pointerup', 'pointercancel', 'pointerleave']) {
    sendBtn.addEventListener(eventName, args.onSendPointerEnd);
  }
  sendBtn.addEventListener('click', args.onSendClick);

  const toolsToggleBtn = document.createElement('button');
  toolsToggleBtn.type = 'button';
  toolsToggleBtn.className = 'smart-input-tools-toggle';
  toolsToggleBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.35" stroke-linecap="round"/></svg>';
  toolsToggleBtn.title = t('smartInput.tools');
  toolsToggleBtn.setAttribute('aria-label', t('smartInput.tools'));
  toolsToggleBtn.setAttribute('aria-haspopup', 'menu');
  toolsToggleBtn.addEventListener('pointerdown', args.onToolsTogglePointerDown);
  toolsToggleBtn.addEventListener('click', args.onToolsToggleClick);

  const inlineToolHost = document.createElement('div');
  inlineToolHost.className = 'smart-input-inline-tools';
  inlineToolHost.hidden = true;

  const photoInput = document.createElement('input');
  photoInput.type = 'file';
  photoInput.accept = 'image/*';
  photoInput.capture = 'environment';
  photoInput.hidden = true;
  photoInput.addEventListener('change', () => {
    if (photoInput.files?.length) {
      args.onPhotoInputChange(photoInput.files);
    }
    photoInput.value = '';
  });

  const attachInput = document.createElement('input');
  attachInput.type = 'file';
  attachInput.multiple = true;
  attachInput.hidden = true;
  attachInput.addEventListener('change', () => {
    if (attachInput.files?.length) {
      args.onAttachInputChange(attachInput.files);
    }
    attachInput.value = '';
  });

  const toolsPanel = document.createElement('div');
  toolsPanel.className = 'manager-bar-action-popover smart-input-tools-surface';
  toolsPanel.hidden = true;

  editorHost.appendChild(lensAttachmentHost);
  textareaShell.appendChild(textarea);
  textareaShell.appendChild(composerExpandBtn);
  editorHost.appendChild(textareaShell);
  inputRow.appendChild(editorHost);
  inputRow.appendChild(inlineToolHost);
  inputRow.appendChild(sendBtn);
  inputRow.appendChild(toolsToggleBtn);
  inputRow.appendChild(toolsPanel);
  inputRow.appendChild(photoInput);
  inputRow.appendChild(attachInput);

  return {
    attachInput,
    composerExpandBtn,
    inlineToolHost,
    inputRow,
    lensAttachmentHost,
    lensQuickSettingsActions,
    lensEffortSelect,
    lensModelSelect,
    lensPermissionSelect,
    lensPlanSelect,
    lensQuickSettingsRow,
    photoInput,
    sendBtn,
    textarea,
    toolsPanel,
    toolsStrip: args.createToolsStrip(),
    toolsToggleBtn,
  };
}

export function syncSmartInputComposerExpandToggleState(
  button: HTMLButtonElement,
  expanded: boolean,
): void {
  button.setAttribute('aria-pressed', expanded ? 'true' : 'false');
  button.setAttribute(
    'aria-label',
    expanded ? t('smartInput.collapseComposer') : t('smartInput.expandComposer'),
  );
  button.title = expanded ? t('smartInput.collapseComposer') : t('smartInput.expandComposer');
  button.dataset.expanded = expanded ? 'true' : 'false';
  button.innerHTML = expanded
    ? '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path d="M15 4h5v5M20 4l-6 6M9 20H4v-5M4 20l6-6M4 9V4h5M4 4l6 6M20 15v5h-5M20 20l-6-6" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    : '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path d="M9 4H4v5M4 4l6 6M15 20h5v-5M20 20l-6-6M20 9V4h-5M20 4l-6 6M4 15v5h5M4 20l6-6" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}

export function createToolButtonsStrip(args: CreateToolButtonsStripArgs): HTMLDivElement {
  const strip = document.createElement('div');
  strip.className = 'smart-input-tools-strip';

  for (const tool of TOOL_ORDER) {
    strip.appendChild(createToolButton(tool, true, args));
  }

  return strip;
}

export function createToolButton(
  tool: ToolKind,
  pinOnUse: boolean,
  args: CreateToolButtonsStripArgs,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.tool = tool;
  button.classList.add('smart-input-tool-button');

  switch (tool) {
    case 'mic':
      button.classList.add('smart-input-mic-btn');
      button.innerHTML = `<span class="smart-input-tool-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg></span><span class="smart-input-tool-label">${t('smartInput.mic')}</span>`;
      button.title = t('smartInput.mic');
      button.hidden = !args.canUseVoice;
      button.addEventListener('pointerdown', (event) => {
        args.onMicPointerDown(pinOnUse, event);
      });
      button.addEventListener('pointercancel', args.onMicPointerCancel);
      button.addEventListener('pointerup', args.onMicPointerUp);
      button.addEventListener('pointerleave', args.onMicPointerLeave);
      break;
    case 'attach':
      button.classList.add('smart-input-attach-btn');
      button.innerHTML = `<span class="smart-input-tool-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5a2.5 2.5 0 0 1 5 0v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5a2.5 2.5 0 0 0 5 0V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z"/></svg></span><span class="smart-input-tool-label">${t('smartInput.attach')}</span>`;
      button.title = t('smartInput.attach');
      button.addEventListener('click', (event) => {
        args.onAttachClick(pinOnUse, event);
      });
      break;
    case 'photo':
      button.classList.add('smart-input-photo-btn');
      button.innerHTML = `<span class="smart-input-tool-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z"/><path d="M9 2 7.17 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2h-3.17L15 2H9zm3 15c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5z"/></svg></span><span class="smart-input-tool-label">${t('smartInput.photo')}</span>`;
      button.title = t('smartInput.photo');
      button.addEventListener('click', (event) => {
        args.onPhotoClick(pinOnUse, event);
      });
      break;
  }

  return button;
}

export function openFileInputPicker(input: HTMLInputElement): void {
  try {
    if (typeof input.showPicker === 'function') {
      input.showPicker();
      return;
    }
  } catch {
    // Fall back to click() when the browser rejects showPicker on this surface.
  }

  input.click();
}

export function renderTerminalStatusRow(args: RenderTerminalStatusRowArgs): boolean {
  let renderedAny = false;
  if (args.autoSendEnabled) {
    const autoSendPill = document.createElement('div');
    autoSendPill.className = 'adaptive-footer-status-pill';
    autoSendPill.textContent = t('smartInput.autoSend');
    args.footerStatusHost.appendChild(autoSendPill);
    renderedAny = true;
  }

  return renderedAny;
}

export function createTerminalTouchToggleButton(
  args: CreateTerminalTouchToggleButtonArgs,
): HTMLButtonElement {
  const keysToggle = document.createElement('button');
  keysToggle.type = 'button';
  keysToggle.className = 'adaptive-footer-context-toggle adaptive-footer-status-toggle';
  keysToggle.textContent = args.expanded ? t('smartInput.keysHide') : t('smartInput.keysShow');
  keysToggle.setAttribute('aria-pressed', args.expanded ? 'true' : 'false');
  keysToggle.dataset.expanded = args.expanded ? 'true' : 'false';
  keysToggle.addEventListener('click', args.onToggle);
  return keysToggle;
}

export function formatLensQuickSettingsSummary(draft: {
  effort?: string | null;
  model?: string | null;
  planMode: string;
}): string {
  const parts = [
    draft.model?.trim() || 'Default',
    draft.effort?.trim() || 'Default',
    draft.planMode === 'on' ? 'PLAN ON' : 'Plan Off',
  ];
  return parts.join(' · ');
}

export function setLensQuickSettingsDropdownOptions(
  select: HTMLSelectElement,
  options: readonly LensQuickSettingsOption[],
): void {
  const nextSignature = options
    .map((option) => `${option.value}\u0000${option.label}`)
    .join('\u0001');
  if (select.dataset.midtermOptionsSignature === nextSignature) {
    return;
  }

  const previousValue = select.value;
  select.replaceChildren();

  for (const option of options) {
    const optionEl = document.createElement('option');
    optionEl.value = option.value;
    optionEl.textContent = option.label;
    select.appendChild(optionEl);
  }

  if ([...select.options].some((option) => option.value === previousValue)) {
    select.value = previousValue;
  }

  select.dataset.midtermOptionsSignature = nextSignature;
  select.dispatchEvent(new Event('midterm:options'));
}

export function setLensQuickSettingsDropdownDisabled(
  select: HTMLSelectElement,
  disabled: boolean,
): void {
  if (select.disabled === disabled) {
    return;
  }

  select.disabled = disabled;
  select.dispatchEvent(new Event('midterm:disabled'));
}

function createLensQuickSettingsField(labelText: string, control: HTMLElement): HTMLDivElement {
  const field = document.createElement('div');
  field.className = 'smart-input-lens-field';

  const label = document.createElement('span');
  label.className = 'smart-input-lens-label';
  label.textContent = labelText;

  field.appendChild(label);
  field.appendChild(control);
  return field;
}

function createLensQuickSettingsDropdown(select: HTMLSelectElement): HTMLDivElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'smart-input-lens-dropdown';

  select.classList.add('smart-input-lens-control-native');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'smart-input-lens-control smart-input-lens-dropdown-trigger';
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');

  const triggerLabel = document.createElement('span');
  triggerLabel.className = 'smart-input-lens-dropdown-trigger-label';

  const triggerChevron = document.createElement('span');
  triggerChevron.className = 'smart-input-lens-dropdown-trigger-chevron';
  triggerChevron.textContent = '▾';

  trigger.appendChild(triggerLabel);
  trigger.appendChild(triggerChevron);

  const menu = document.createElement('div');
  menu.className = 'manager-bar-action-popover smart-input-lens-dropdown-menu hidden';

  const closeMenu = (): void => {
    menu.classList.add('hidden');
    wrapper.classList.remove('smart-input-lens-dropdown-open-up');
    trigger.setAttribute('aria-expanded', 'false');
  };

  const syncDisabledState = (): void => {
    const disabled = select.disabled;
    trigger.disabled = disabled;
    trigger.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    wrapper.classList.toggle('smart-input-lens-dropdown-disabled', disabled);
    if (disabled) {
      closeMenu();
    }
  };

  const updateMenuPlacement = (): void => {
    if (menu.classList.contains('hidden')) {
      wrapper.classList.remove('smart-input-lens-dropdown-open-up');
      return;
    }

    const viewportPadding = 12;
    const gap = 8;
    const triggerRect = trigger.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const availableBelow = window.innerHeight - triggerRect.bottom - viewportPadding - gap;
    const availableAbove = triggerRect.top - viewportPadding - gap;
    const openUp =
      availableBelow < Math.min(menuRect.height, 220) && availableAbove > availableBelow;

    wrapper.classList.toggle('smart-input-lens-dropdown-open-up', openUp);
  };

  const rebuildMenu = (): void => {
    menu.replaceChildren();
    for (const option of [...select.options]) {
      const optionButton = document.createElement('button');
      optionButton.type = 'button';
      optionButton.className = 'manager-bar-action-popover-btn smart-input-lens-dropdown-option';
      optionButton.dataset.value = option.value;
      optionButton.textContent = option.textContent || option.value;
      optionButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (select.value !== option.value) {
          select.value = option.value;
          select.dispatchEvent(new Event('change', { bubbles: false }));
        }
        syncSelection();
        closeMenu();
      });
      menu.appendChild(optionButton);
    }
    syncSelection();
  };

  const syncSelection = (): void => {
    const selectedOption = [...select.options].find((option) => option.value === select.value);
    triggerLabel.textContent = selectedOption ? selectedOption.textContent.trim() : '';
    menu
      .querySelectorAll<HTMLButtonElement>('.smart-input-lens-dropdown-option')
      .forEach((button) => {
        button.classList.toggle('is-selected', button.dataset.value === select.value);
      });
  };

  rebuildMenu();

  trigger.addEventListener('click', (event) => {
    if (select.disabled) {
      closeMenu();
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const nextOpen = menu.classList.contains('hidden');
    document
      .querySelectorAll<HTMLElement>('.smart-input-lens-dropdown-menu:not(.hidden)')
      .forEach((openMenu) => {
        if (openMenu !== menu) {
          openMenu.classList.add('hidden');
        }
      });
    document
      .querySelectorAll<HTMLButtonElement>(
        '.smart-input-lens-dropdown-trigger[aria-expanded="true"]',
      )
      .forEach((openTrigger) => {
        if (openTrigger !== trigger) {
          openTrigger.setAttribute('aria-expanded', 'false');
        }
      });
    if (!nextOpen) {
      closeMenu();
      return;
    }

    menu.classList.remove('hidden');
    updateMenuPlacement();
    trigger.setAttribute('aria-expanded', 'true');
  });

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Node) || !wrapper.contains(target)) {
      closeMenu();
    }
  });
  window.addEventListener('resize', updateMenuPlacement);
  document.addEventListener('scroll', updateMenuPlacement, true);

  select.addEventListener('midterm:options', rebuildMenu as EventListener);
  select.addEventListener('midterm:disabled', syncDisabledState as EventListener);
  select.addEventListener('change', syncSelection);
  select.addEventListener('midterm:sync', syncSelection as EventListener);
  syncSelection();
  syncDisabledState();

  wrapper.appendChild(select);
  wrapper.appendChild(trigger);
  wrapper.appendChild(menu);
  return wrapper;
}
