/**
 * Settings Persistence Module
 *
 * Handles loading, saving, and form binding for application settings.
 * Communicates with the server API to persist settings changes.
 */

import type { TerminalState } from '../../types';
import type {
  MidTermSettingsPublic,
  MidTermSettingsUpdate,
  TerminalColorSchemeDefinition,
  UserInfo,
} from '../../api/types';
import type { ITerminalOptions } from '@xterm/xterm';
import { JS_BUILD_VERSION } from '../../constants';
import { applyCssTheme } from '../theming/cssThemes';
import { applyBackgroundAppearance, getBackgroundImageUrl } from '../theming/backgroundAppearance';
import {
  BUILT_IN_TERMINAL_COLOR_SCHEME_OPTIONS,
  DEFAULT_TERMINAL_COLOR_SCHEME_FALLBACKS,
  TERMINAL_COLOR_SCHEME_FIELDS,
  TERMINAL_COLOR_SCHEME_TEXT_PLACEHOLDERS,
  type TerminalColorSchemeFieldKey,
  findCustomTerminalColorScheme,
  getBuiltInTerminalTheme,
  isBuiltInTerminalColorSchemeName,
  suggestCustomTerminalColorSchemeName,
  themeToTerminalColorSchemeDefinition,
} from '../theming/terminalColorSchemes';
import {
  getEffectiveXtermThemeForSettings,
  syncEffectiveXtermThemeDomOverrides,
} from '../theming/themes';
import { dom, sessionTerminals } from '../../state';
import { $settingsOpen, $currentSettings } from '../../stores';
import { setCookie } from '../../utils';
import {
  getSettings,
  getUsers,
  getVersion,
  getHealth,
  updateSettings,
  uploadBackgroundImage,
  deleteBackgroundImage,
} from '../../api/client';
import { updateTabTitle } from '../tabTitle';
import { getEffectiveTerminalFontSize } from '../terminal/fontSize';
import {
  buildTerminalFontStack,
  ensureTerminalFontLoaded,
  DEFAULT_TERMINAL_FONT_WEIGHT,
  DEFAULT_TERMINAL_FONT_WEIGHT_BOLD,
} from '../terminal/fontConfig';
import { refreshTerminalPresentation } from '../terminal/scaling';
import {
  applyTerminalScrollbarStyleClass,
  normalizeScrollbarStyle,
} from '../terminal/scrollbarStyle';
import { syncTerminalWebglState } from '../terminal/manager';
import { shouldUseWebglRenderer } from '../terminal/webglSupport';
import { setLocale, t } from '../i18n';
import { renderUpdatePanel } from '../updating/checker';
import { createLogger } from '../logging';
import { setDevMode } from '../sidebar/voiceSection';
import { syncInlineTextInputWrappers, updateInlineTextInputWrapperState } from './inlineInputState';
import {
  getSettingsRegistryControlEntries,
  getSettingsRegistryWritableEntries,
  type SettingsRegistryEntry,
  VALID_SETTING_SHELLS,
} from './registry';

const log = createLogger('settings');

// AbortController for settings event listeners cleanup
let settingsAbortController: AbortController | null = null;
let settingsSaveVersion = 0;
let terminalFontSettingsSaveTimer: number | null = null;
let settingsFormHydrated = false;
let settingsSaveArmed = false;
type TerminalFontWeight = NonNullable<ITerminalOptions['fontWeight']>;
type TerminalColorSchemeEditorGroup = 'Core' | 'Standard ANSI' | 'Bright ANSI' | 'Advanced';

const TERMINAL_COLOR_SCHEME_EDITOR_GROUPS: readonly TerminalColorSchemeEditorGroup[] = [
  'Core',
  'Standard ANSI',
  'Bright ANSI',
  'Advanced',
];

function applySettingsLocally(settings: MidTermSettingsPublic): void {
  $currentSettings.set(settings);
  applyCssTheme(settings.theme);
  applySettingsToTerminals();
  updateTabTitle();
  void setLocale(settings.language);
  renderUpdatePanel();

  if ($settingsOpen.get() && dom.settingsView) {
    syncInlineTextInputWrappers(dom.settingsView);
  }
}

/**
 * Set the value of a form element by ID
 */
export function setElementValue(id: string, value: string | number): void {
  const el = document.getElementById(id) as
    | HTMLInputElement
    | HTMLSelectElement
    | HTMLTextAreaElement
    | null;
  if (el) el.value = String(value);
}

/**
 * Set the checked state of a checkbox by ID
 */
export function setElementChecked(id: string, checked: boolean): void {
  const el = document.getElementById(id) as HTMLInputElement | null;
  if (el) el.checked = checked;
}

/**
 * Get the value of a form element by ID
 */
export function getElementValue(id: string, defaultValue: string): string {
  const el = document.getElementById(id) as
    | HTMLInputElement
    | HTMLSelectElement
    | HTMLTextAreaElement
    | null;
  return el ? el.value : defaultValue;
}

/**
 * Get the checked state of a checkbox by ID
 */
export function getElementChecked(id: string): boolean {
  const el = document.getElementById(id) as HTMLInputElement | null;
  return el ? el.checked : false;
}

function getRegistryFallbackValue(entry: SettingsRegistryEntry): string | number | boolean {
  if (typeof entry.fallbackValue === 'number') {
    return entry.fallbackValue;
  }

  if (typeof entry.fallbackValue === 'boolean') {
    return entry.fallbackValue;
  }

  if (typeof entry.fallbackValue === 'string') {
    return entry.fallbackValue;
  }

  return '';
}

function setRegistryControlValue(
  entry: SettingsRegistryEntry,
  value: MidTermSettingsPublic[keyof MidTermSettingsPublic],
): void {
  if (!entry.controlId || !entry.controlType) {
    return;
  }

  if (entry.controlType === 'checkbox') {
    setElementChecked(entry.controlId, Boolean(value ?? entry.fallbackValue));
    return;
  }

  const fallback = getRegistryFallbackValue(entry);
  setElementValue(entry.controlId, (value ?? fallback) as string | number);
}

function readRegistryControlValue(
  entry: SettingsRegistryEntry,
  prevSettings: MidTermSettingsPublic | null,
): unknown {
  if (entry.saveStrategy === 'preserve') {
    return prevSettings?.[entry.key] ?? entry.fallbackValue;
  }

  if (!entry.controlId || !entry.controlType) {
    return entry.fallbackValue;
  }

  if (entry.controlType === 'checkbox') {
    return getElementChecked(entry.controlId);
  }

  const rawValue = getElementValue(entry.controlId, String(getRegistryFallbackValue(entry)));

  switch (entry.controlType) {
    case 'nullable-string':
      return rawValue || null;
    case 'int': {
      const parsed = Number.parseInt(rawValue, 10);
      return Number.isFinite(parsed) ? parsed : entry.fallbackValue;
    }
    case 'float': {
      const parsed = Number.parseFloat(rawValue);
      return Number.isFinite(parsed) ? parsed : entry.fallbackValue;
    }
    case 'shell-select':
      return VALID_SETTING_SHELLS.includes(rawValue as (typeof VALID_SETTING_SHELLS)[number])
        ? rawValue
        : null;
    case 'textarea':
    case 'text':
    case 'select':
    default:
      return rawValue;
  }
}

function buildSettingsUpdateFromRegistry(
  prevSettings: MidTermSettingsPublic | null,
): MidTermSettingsUpdate {
  const result: Partial<MidTermSettingsUpdate> = {};

  getSettingsRegistryWritableEntries().forEach((entry) => {
    (result as Record<string, unknown>)[entry.key] = readRegistryControlValue(entry, prevSettings);
  });

  return result as MidTermSettingsUpdate;
}

function areSettingValuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }

  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  return false;
}

function hasPendingSettingsChanges(): boolean {
  if (!settingsFormHydrated || !settingsSaveArmed) {
    return false;
  }

  const current = $currentSettings.get();
  if (!current) {
    return false;
  }

  const pending = buildSettingsUpdateFromRegistry(current);
  const pendingValues = pending as Record<string, unknown>;
  const currentValues = current as Record<string, unknown>;
  return getSettingsRegistryWritableEntries().some((entry) => {
    const key = entry.key;
    return !areSettingValuesEqual(pendingValues[key], currentValues[key]);
  });
}

function flushPendingSettingsChanges(): void {
  if (terminalFontSettingsSaveTimer !== null) {
    window.clearTimeout(terminalFontSettingsSaveTimer);
    terminalFontSettingsSaveTimer = null;
  }

  if (hasPendingSettingsChanges()) {
    saveAllSettings();
  }
}

/**
 * Populate version info in the about section
 */
export function populateVersionInfo(
  serverVersion: string | null,
  hostVersion: string | null,
  frontendVersion: string,
  devMode?: boolean,
  codeSigned?: boolean,
): void {
  // Strip git hash suffix but preserve [LOCAL] indicator
  const formatVersion = (v: string) => 'v' + v.replace(/[+-][a-f0-9]+$/i, '');

  const serverEl = document.getElementById('version-server');
  if (serverEl && serverVersion) {
    serverEl.textContent = formatVersion(serverVersion);
  }

  const frontendEl = document.getElementById('version-frontend');
  if (frontendEl) {
    frontendEl.textContent = frontendVersion === 'dev' ? 'dev' : formatVersion(frontendVersion);
  }

  const hostEl = document.getElementById('version-host');
  if (hostEl) {
    hostEl.textContent = hostVersion ? formatVersion(hostVersion) : '-';
  }

  const envRow = document.getElementById('dev-environment-row');
  const envEl = document.getElementById('dev-environment-name');
  if (envRow && envEl) {
    if (devMode) {
      envRow.style.display = '';
      envEl.textContent = 'DEV';
    } else {
      envRow.style.display = 'none';
    }
  }

  const sigEl = document.getElementById('code-signing-value');
  if (sigEl) {
    if (codeSigned) {
      sigEl.textContent = t('settings.general.signed');
      sigEl.className = 'version-value signed-badge';
    } else {
      sigEl.textContent = t('settings.general.unsigned');
      sigEl.className = 'version-value unsigned-badge';
    }
  }
}

/**
 * Populate user dropdown for run-as-user selection
 */
export function populateUserDropdown(
  users: Array<{ username: string }>,
  selectedUser: string | null,
): void {
  const select = document.getElementById('setting-run-as-user') as HTMLSelectElement | null;
  if (!select) return;

  select.innerHTML = '<option value="">Process Owner (default)</option>';

  users.forEach((user) => {
    const option = document.createElement('option');
    option.value = user.username;
    option.textContent = user.username;
    if (user.username === selectedUser) {
      option.selected = true;
    }
    select.appendChild(option);
  });

  if (
    selectedUser &&
    !users.some(
      (user) =>
        user.username.localeCompare(selectedUser, undefined, { sensitivity: 'accent' }) === 0,
    )
  ) {
    const option = document.createElement('option');
    option.value = selectedUser;
    option.textContent = selectedUser;
    option.selected = true;
    select.appendChild(option);
  }
}

/**
 * Populate the settings form with current settings
 */
export function populateSettingsForm(settings: MidTermSettingsPublic): void {
  settingsFormHydrated = false;
  settingsSaveArmed = false;
  syncTerminalColorSchemeOptions(settings);
  getSettingsRegistryControlEntries().forEach((entry) => {
    setRegistryControlValue(entry, settings[entry.key]);
  });
  updateTransparencyValue('setting-ui-transparency-value', settings.uiTransparency);
  updateTransparencyValue(
    'setting-terminal-transparency-value',
    settings.terminalTransparency ?? settings.uiTransparency,
  );
  updateBackgroundImageUi(settings);
  if (dom.settingsView) {
    syncInlineTextInputWrappers(dom.settingsView);
  }

  settingsFormHydrated = true;
}

/**
 * Fetch settings, users, version, and health from server and populate the form
 */
export async function fetchSettings(): Promise<void> {
  const cachedSettings = $currentSettings.get();
  if (cachedSettings) {
    populateSettingsForm(cachedSettings);
    bindSettingsAutoSave();
  }

  try {
    let settingsData = cachedSettings;
    if (!settingsData) {
      const { data, response } = await getSettings();
      if (!data || !response.ok) {
        log.error(() => `Error fetching settings: ${response.status}`);
        return;
      }

      settingsData = data;
      $currentSettings.set(settingsData);
      populateSettingsForm(settingsData);
      bindSettingsAutoSave();
    }

    const [usersRes, versionRes, healthRes] = await Promise.all([
      getUsers(),
      getVersion(),
      getHealth(),
    ]);

    const users = (usersRes.data ?? []).map((u: UserInfo) => ({
      username: u.username,
      displayName: u.username,
    }));
    const version = versionRes.data ?? null;
    const health = healthRes.data;

    populateUserDropdown(users, settingsData.runAsUser ?? null);
    populateVersionInfo(
      version,
      health?.ttyHostVersion ?? null,
      JS_BUILD_VERSION,
      settingsData.devMode,
    );

    applySettingsToTerminals();
  } catch (e) {
    log.error(() => `Error fetching settings: ${String(e)}`);
  }
}

/**
 * Apply current settings to all open terminals
 */
export function applySettingsToTerminals(settingsOverride?: MidTermSettingsPublic): void {
  const settings = settingsOverride ?? $currentSettings.get();
  if (!settings) return;

  applyBackgroundAppearance(settings);
  syncEffectiveXtermThemeDomOverrides(settings);
  const theme = getEffectiveXtermThemeForSettings(settings);
  const fontFamily = buildTerminalFontStack(settings.fontFamily);
  const fontSize = getEffectiveTerminalFontSize(settings.fontSize);
  const lineHeight = settings.lineHeight;
  const letterSpacing = settings.letterSpacing;
  const fontWeight = settings.fontWeight as TerminalFontWeight;
  const fontWeightBold = settings.fontWeightBold as TerminalFontWeight;
  const contrastRatio = settings.minimumContrastRatio;
  const fontLoadPromise = ensureTerminalFontLoaded(settings.fontFamily, fontSize);
  let hasFontChanges = false;

  const scrollbarStyle = normalizeScrollbarStyle(settings.scrollbarStyle);

  for (const [sessionId, state] of sessionTerminals.entries()) {
    if (
      state.terminal.options.fontFamily !== fontFamily ||
      state.terminal.options.fontSize !== fontSize ||
      state.terminal.options.lineHeight !== lineHeight ||
      state.terminal.options.letterSpacing !== letterSpacing ||
      String(state.terminal.options.fontWeight ?? DEFAULT_TERMINAL_FONT_WEIGHT) !== fontWeight ||
      String(state.terminal.options.fontWeightBold ?? DEFAULT_TERMINAL_FONT_WEIGHT_BOLD) !==
        fontWeightBold
    ) {
      hasFontChanges = true;
    }

    state.terminal.options.cursorBlink = settings.cursorBlink;
    state.terminal.options.cursorStyle = settings.cursorStyle;
    state.terminal.options.cursorInactiveStyle = settings.cursorInactiveStyle;
    state.terminal.options.fontFamily = fontFamily;
    state.terminal.options.fontSize = fontSize;
    state.terminal.options.lineHeight = lineHeight;
    state.terminal.options.letterSpacing = letterSpacing;
    state.terminal.options.fontWeight = fontWeight;
    state.terminal.options.fontWeightBold = fontWeightBold;
    state.terminal.options.theme = theme;
    state.terminal.options.minimumContrastRatio = contrastRatio;
    state.terminal.options.smoothScrollDuration = settings.smoothScrolling ? 150 : 0;
    state.terminal.options.scrollback = settings.scrollbackLines;
    syncTerminalWebglState(sessionId, state, shouldUseWebglRenderer(settings));

    applyTerminalScrollbarStyleClass(state.container, scrollbarStyle);

    refreshTerminalPresentation(sessionId, state);
  }

  if (hasFontChanges) {
    void fontLoadPromise.then(() => {
      sessionTerminals.forEach((state: TerminalState, sessionId: string) => {
        refreshTerminalPresentation(sessionId, state);
      });
    });
  }
}

/**
 * Apply settings received from WebSocket sync.
 * Updates the form if settings panel is open, applies to terminals, and updates theme.
 */
export function applyReceivedSettings(settings: MidTermSettingsPublic): void {
  $currentSettings.set(settings);
  if ($settingsOpen.get()) {
    populateSettingsForm(settings);
  }

  applyCssTheme(settings.theme);
  setCookie('mm-theme', settings.theme);

  setCookie('mm-language', settings.language);
  void setLocale(settings.language);

  applySettingsToTerminals();
  updateTabTitle();
  renderUpdatePanel();

  const envRow = document.getElementById('dev-environment-row');
  const envEl = document.getElementById('dev-environment-name');
  if (envRow && envEl) {
    if (settings.devMode) {
      envRow.style.display = '';
      envEl.textContent = 'DEV';
    } else {
      envRow.style.display = 'none';
    }
  }
}

/**
 * Save all settings to the server
 */
export function saveAllSettings(): void {
  if (!settingsFormHydrated || !settingsSaveArmed) {
    return;
  }

  if (!validateAgentEnvironmentInputs()) {
    return;
  }

  const prevSettings = $currentSettings.get();
  const settings = buildSettingsUpdateFromRegistry(prevSettings);
  const nextSettings = prevSettings ? { ...prevSettings, ...settings } : null;

  persistSettingsSnapshot(prevSettings, nextSettings, settings);
}

function persistSettingsSnapshot(
  prevSettings: MidTermSettingsPublic | null,
  nextSettings: MidTermSettingsPublic | null,
  payload: MidTermSettingsUpdate,
): void {
  setCookie('mm-theme', payload.theme);

  setCookie('mm-language', payload.language);

  const saveVersion = ++settingsSaveVersion;

  if (nextSettings) {
    applySettingsLocally(nextSettings);
  }

  updateSettings(payload)
    .then(({ response, error }) => {
      if (response.ok) {
        if (!nextSettings && prevSettings) {
          applySettingsLocally({ ...prevSettings, ...payload });
        }
      } else {
        log.error(() => `Settings save failed: ${response.status} ${String(error)}`);
        if (prevSettings && settingsSaveVersion === saveVersion) {
          applySettingsLocally(prevSettings);
          if ($settingsOpen.get()) {
            populateSettingsForm(prevSettings);
          }
        }
      }
    })
    .catch((e: unknown) => {
      log.error(() => `Error saving settings: ${String(e)}`);
      if (prevSettings && settingsSaveVersion === saveVersion) {
        applySettingsLocally(prevSettings);
        if ($settingsOpen.get()) {
          populateSettingsForm(prevSettings);
        }
      }
    });
}

/**
 * Bind auto-save behavior to settings form elements.
 * Uses AbortController for cleanup when settings panel closes.
 */
export function bindSettingsAutoSave(): void {
  // Clean up previous listeners first
  unbindSettingsAutoSave(false);

  const settingsView = dom.settingsView;
  if (!settingsView) return;

  settingsAbortController = new AbortController();
  const { signal } = settingsAbortController;

  const armSettingsSave = (): void => {
    if (settingsFormHydrated) {
      settingsSaveArmed = true;
    }
  };

  settingsView.addEventListener('pointerdown', armSettingsSave, { capture: true, signal });
  settingsView.addEventListener('keydown', armSettingsSave, { capture: true, signal });

  settingsView
    .querySelectorAll('select[id^="setting-"], input[type="checkbox"][id^="setting-"]')
    .forEach((el) => {
      el.addEventListener('change', saveAllSettings, { signal });
    });

  settingsView.querySelectorAll('input[type="range"][id^="setting-"]').forEach((el) => {
    el.addEventListener('change', saveAllSettings, { signal });
  });

  settingsView
    .querySelectorAll('input[id^="setting-"][type="text"], input[id^="setting-"][type="number"]')
    .forEach((el) => {
      if (!(el instanceof HTMLInputElement)) {
        return;
      }

      el.addEventListener(
        'change',
        () => {
          saveAllSettings();
          syncInlineTextInputWrappers(settingsView);
        },
        { signal },
      );
    });

  settingsView.querySelectorAll('textarea').forEach((el) => {
    if (!(el instanceof HTMLTextAreaElement)) {
      return;
    }

    el.addEventListener(
      'change',
      () => {
        saveAllSettings();
      },
      { signal },
    );

    el.addEventListener(
      'input',
      () => {
        el.setCustomValidity('');
      },
      { signal },
    );
  });

  const uiTransparencySlider = document.getElementById(
    'setting-ui-transparency',
  ) as HTMLInputElement | null;
  bindTransparencyPreview(uiTransparencySlider, 'setting-ui-transparency-value', signal);

  const terminalTransparencySlider = document.getElementById(
    'setting-terminal-transparency',
  ) as HTMLInputElement | null;
  bindTransparencyPreview(
    terminalTransparencySlider,
    'setting-terminal-transparency-value',
    signal,
  );

  const fontSizeInput = document.getElementById('setting-font-size') as HTMLInputElement | null;
  bindTerminalFontPreview(
    fontSizeInput,
    (current, fontSize) => ({ ...current, fontSize }),
    (value) => Number.parseInt(value, 10),
    signal,
  );

  const lineHeightInput = document.getElementById('setting-line-height') as HTMLInputElement | null;
  bindTerminalFontPreview(
    lineHeightInput,
    (current, lineHeight) => ({ ...current, lineHeight }),
    (value) => Number.parseFloat(value),
    signal,
  );

  const letterSpacingInput = document.getElementById(
    'setting-letter-spacing',
  ) as HTMLInputElement | null;
  bindTerminalFontPreview(
    letterSpacingInput,
    (current, letterSpacing) => ({ ...current, letterSpacing }),
    (value) => Number.parseFloat(value),
    signal,
  );

  const uploadInput = document.getElementById(
    'setting-background-upload',
  ) as HTMLInputElement | null;
  const uploadBtn = document.getElementById('btn-background-upload') as HTMLButtonElement | null;
  const removeBtn = document.getElementById('btn-background-remove') as HTMLButtonElement | null;

  uploadBtn?.addEventListener(
    'click',
    () => {
      uploadInput?.click();
    },
    { signal },
  );

  uploadInput?.addEventListener(
    'change',
    () => {
      const file = uploadInput.files?.[0];
      if (!file) return;
      void handleBackgroundImageUpload(file);
      uploadInput.value = '';
    },
    { signal },
  );

  removeBtn?.addEventListener(
    'click',
    () => {
      void handleBackgroundImageDelete();
    },
    { signal },
  );

  bindTerminalColorSchemeEditor(signal);

  settingsView.querySelectorAll('.text-input-wrapper').forEach((wrapper) => {
    const input = wrapper.querySelector('input[type="text"], input[type="number"]');
    const saveBtn = wrapper.querySelector('.inline-save-btn');
    if (!(wrapper instanceof HTMLElement) || !(input instanceof HTMLInputElement) || !saveBtn) {
      return;
    }

    input.addEventListener(
      'input',
      () => {
        updateInlineTextInputWrapperState(input);
      },
      { signal },
    );

    saveBtn.addEventListener(
      'mousedown',
      (event) => {
        event.preventDefault();
      },
      { signal },
    );

    saveBtn.addEventListener(
      'click',
      () => {
        saveAllSettings();
        syncInlineTextInputWrappers(settingsView);
      },
      { signal },
    );

    input.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          saveAllSettings();
          syncInlineTextInputWrappers(settingsView);
        }
      },
      { signal },
    );
  });
}

/**
 * Clean up settings event listeners
 */
export function unbindSettingsAutoSave(resetHydrationState = true): void {
  flushPendingSettingsChanges();

  if (settingsAbortController) {
    settingsAbortController.abort();
    settingsAbortController = null;
  }

  if (resetHydrationState) {
    settingsFormHydrated = false;
    settingsSaveArmed = false;
  }
}

function bindTransparencyPreview(
  slider: HTMLInputElement | null,
  labelId: string,
  signal: AbortSignal,
): void {
  if (!slider) {
    return;
  }

  slider.addEventListener(
    'input',
    () => {
      const value = Number.parseInt(slider.value, 10) || 0;
      updateTransparencyValue(labelId, value);
      const current = $currentSettings.get();
      if (!current) {
        return;
      }

      previewTransparencySettings(resolvePreviewTransparencySettings(current));
    },
    { signal },
  );
}

function scheduleTerminalFontSettingsSave(): void {
  if (terminalFontSettingsSaveTimer !== null) {
    window.clearTimeout(terminalFontSettingsSaveTimer);
  }

  terminalFontSettingsSaveTimer = window.setTimeout(() => {
    terminalFontSettingsSaveTimer = null;
    saveAllSettings();
  }, 150);
}

function bindTerminalFontPreview(
  input: HTMLInputElement | null,
  applyPatch: (current: MidTermSettingsPublic, value: number) => MidTermSettingsPublic,
  parse: (value: string) => number,
  signal: AbortSignal,
): void {
  if (!input) {
    return;
  }

  input.addEventListener(
    'input',
    () => {
      if (!input.validity.valid) {
        return;
      }

      const current = $currentSettings.get();
      const nextValue = parse(input.value);
      if (!current || !Number.isFinite(nextValue)) {
        return;
      }

      applySettingsToTerminals(applyPatch(current, nextValue));
      scheduleTerminalFontSettingsSave();
    },
    { signal },
  );
}

function resolvePreviewTransparencySettings(current: MidTermSettingsPublic): MidTermSettingsPublic {
  const uiSlider = document.getElementById('setting-ui-transparency') as HTMLInputElement | null;
  const terminalSlider = document.getElementById(
    'setting-terminal-transparency',
  ) as HTMLInputElement | null;

  const uiTransparency = Number.parseInt(uiSlider?.value ?? '', 10);
  const terminalTransparency = Number.parseInt(terminalSlider?.value ?? '', 10);

  return {
    ...current,
    uiTransparency: Number.isFinite(uiTransparency) ? uiTransparency : current.uiTransparency,
    terminalTransparency: Number.isFinite(terminalTransparency)
      ? terminalTransparency
      : (current.terminalTransparency ?? current.uiTransparency),
  };
}

function previewTransparencySettings(settings: MidTermSettingsPublic): void {
  applyBackgroundAppearance(settings);
  syncEffectiveXtermThemeDomOverrides(settings);
  const theme = getEffectiveXtermThemeForSettings(settings);

  for (const [sessionId, state] of sessionTerminals.entries()) {
    state.terminal.options.theme = theme;
    refreshTerminalPresentation(sessionId, state);
  }
}

function updateTransparencyValue(labelId: string, value: number): void {
  const label = document.getElementById(labelId);
  if (label) {
    label.textContent = `${String(value)}%`;
  }
}

function ensureTerminalColorSchemeEditorRendered(): void {
  const host = document.getElementById('terminal-color-scheme-editor-fields');
  if (!(host instanceof HTMLElement) || host.childElementCount > 0) {
    return;
  }

  for (const groupName of TERMINAL_COLOR_SCHEME_EDITOR_GROUPS) {
    const group = document.createElement('section');
    group.className = 'terminal-color-scheme-editor-group';

    const title = document.createElement('h4');
    title.className = 'terminal-color-scheme-editor-group-title';
    title.textContent = groupName;
    group.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'terminal-color-scheme-editor-grid';

    for (const field of TERMINAL_COLOR_SCHEME_FIELDS.filter((entry) => entry.group === groupName)) {
      const item = document.createElement('label');
      item.className = 'terminal-color-scheme-editor-field';

      const text = document.createElement('span');
      text.className = 'terminal-color-scheme-editor-field-label';
      text.textContent = field.label;
      item.appendChild(text);

      const input = document.createElement('input');
      input.id = `terminal-color-scheme-field-${field.key}`;
      input.setAttribute('data-terminal-color-scheme-field', field.key);
      input.className =
        field.input === 'color'
          ? 'terminal-color-scheme-editor-input terminal-color-scheme-editor-color'
          : 'terminal-color-scheme-editor-input';
      input.type = field.input === 'color' ? 'color' : 'text';
      input.spellcheck = false;

      if (field.input === 'text') {
        input.placeholder = field.label.includes('Scrollbar')
          ? TERMINAL_COLOR_SCHEME_TEXT_PLACEHOLDERS.scrollbarColor
          : '';
      }

      item.appendChild(input);
      grid.appendChild(item);
    }

    group.appendChild(grid);
    host.appendChild(group);
  }
}

function getTerminalColorSchemeEditorFieldInput(
  key: TerminalColorSchemeFieldKey,
): HTMLInputElement | null {
  const input = document.getElementById(`terminal-color-scheme-field-${key}`);
  return input instanceof HTMLInputElement ? input : null;
}

function getTerminalColorSchemeEditorNameInput(): HTMLInputElement | null {
  const input = document.getElementById('terminal-color-scheme-editor-name');
  return input instanceof HTMLInputElement ? input : null;
}

function getTerminalColorSchemeEditorSourceSelect(): HTMLSelectElement | null {
  const select = document.getElementById('terminal-color-scheme-editor-source');
  return select instanceof HTMLSelectElement ? select : null;
}

function getTerminalColorSchemeEditorStatusElement(): HTMLElement | null {
  const element = document.getElementById('terminal-color-scheme-editor-status');
  return element instanceof HTMLElement ? element : null;
}

function getTerminalColorSchemeEditorRoot(): HTMLElement | null {
  const element = document.getElementById('terminal-color-scheme-editor');
  return element instanceof HTMLElement ? element : null;
}

function getTranslatedSettingLabel(key: string, fallback: string): string {
  const translated = t(key);
  return translated && translated !== key ? translated : fallback;
}

function appendTranslatedOption(
  select: HTMLSelectElement,
  value: string,
  translationKey: string,
  fallbackText: string,
): void {
  const option = document.createElement('option');
  option.value = value;
  option.setAttribute('data-i18n', translationKey);
  option.textContent = getTranslatedSettingLabel(translationKey, fallbackText);
  select.appendChild(option);
}

function getBuiltInTerminalColorSchemeLabel(value: string): string {
  const option = BUILT_IN_TERMINAL_COLOR_SCHEME_OPTIONS.find((entry) => entry.value === value);
  return option ? getTranslatedSettingLabel(option.translationKey, option.fallbackText) : value;
}

function syncTerminalColorSchemeEditorSourceOptions(
  settings: MidTermSettingsPublic | null | undefined,
  selectedValue: string,
): void {
  const select = getTerminalColorSchemeEditorSourceSelect();
  if (!select) {
    return;
  }

  const preferredValue =
    selectedValue === 'auto' ? (settings?.theme ?? 'dark') : selectedValue || 'dark';
  const existingValue = select.value;

  select.innerHTML = '';

  const presetsGroup = document.createElement('optgroup');
  presetsGroup.label = 'Presets';
  for (const definition of BUILT_IN_TERMINAL_COLOR_SCHEME_OPTIONS) {
    const option = document.createElement('option');
    option.value = definition.value;
    option.textContent = getTranslatedSettingLabel(
      definition.translationKey,
      definition.fallbackText,
    );
    presetsGroup.appendChild(option);
  }
  select.appendChild(presetsGroup);

  if ((settings?.terminalColorSchemes.length ?? 0) > 0) {
    const customGroup = document.createElement('optgroup');
    customGroup.label = 'Custom Schemes';
    for (const definition of settings?.terminalColorSchemes ?? []) {
      const option = document.createElement('option');
      option.value = definition.name;
      option.textContent = definition.name;
      customGroup.appendChild(option);
    }
    select.appendChild(customGroup);
  }

  const nextValue = Array.from(select.options).some((option) => option.value === existingValue)
    ? existingValue
    : preferredValue;

  select.value = Array.from(select.options).some((option) => option.value === nextValue)
    ? nextValue
    : 'dark';
}

function fillTerminalColorSchemeEditor(definition: TerminalColorSchemeDefinition): void {
  const nameInput = getTerminalColorSchemeEditorNameInput();
  if (nameInput) {
    nameInput.value = definition.name;
  }

  for (const field of TERMINAL_COLOR_SCHEME_FIELDS) {
    const input = getTerminalColorSchemeEditorFieldInput(field.key);
    if (!input) {
      continue;
    }

    input.value = definition[field.key];
  }
}

function loadTerminalColorSchemeEditorFromSource(
  settings: MidTermSettingsPublic | null | undefined,
  sourceName: string,
): void {
  const editorRoot = getTerminalColorSchemeEditorRoot();
  if (!editorRoot) {
    return;
  }

  const builtInTheme = getBuiltInTerminalTheme(sourceName);
  const customScheme = builtInTheme ? null : findCustomTerminalColorScheme(settings, sourceName);

  let definition: TerminalColorSchemeDefinition | null = null;
  if (builtInTheme) {
    definition = themeToTerminalColorSchemeDefinition(
      suggestCustomTerminalColorSchemeName(
        getBuiltInTerminalColorSchemeLabel(sourceName),
        settings,
      ),
      builtInTheme,
    );
    editorRoot.dataset.sourceKind = 'preset';
  } else if (customScheme) {
    definition = { ...customScheme };
    editorRoot.dataset.sourceKind = 'custom';
  }

  if (!definition) {
    const darkTheme = getBuiltInTerminalTheme('dark');
    if (!darkTheme) {
      return;
    }

    definition = themeToTerminalColorSchemeDefinition(
      suggestCustomTerminalColorSchemeName('Custom Scheme', settings),
      darkTheme,
    );
    editorRoot.dataset.sourceKind = 'blank';
  }

  editorRoot.dataset.initialized = 'true';
  editorRoot.dataset.sourceName = sourceName;
  fillTerminalColorSchemeEditor(definition);
  syncTerminalColorSchemeEditorActions(settings);
}

function readTerminalColorSchemeEditorDefinition(): TerminalColorSchemeDefinition | null {
  const nameInput = getTerminalColorSchemeEditorNameInput();
  if (!nameInput) {
    return null;
  }

  const definition: TerminalColorSchemeDefinition = {
    name: nameInput.value.trim(),
    ...DEFAULT_TERMINAL_COLOR_SCHEME_FALLBACKS,
  };

  for (const field of TERMINAL_COLOR_SCHEME_FIELDS) {
    const input = getTerminalColorSchemeEditorFieldInput(field.key);
    if (!input) {
      return null;
    }

    definition[field.key] = input.value.trim();
  }

  return definition;
}

function getTerminalColorSchemeEditorValidation(
  settings: MidTermSettingsPublic | null | undefined,
): { valid: boolean; message: string; canDelete: boolean } {
  const definition = readTerminalColorSchemeEditorDefinition();
  if (!definition) {
    return { valid: false, message: 'Editor is unavailable.', canDelete: false };
  }

  if (!definition.name) {
    return { valid: false, message: 'Enter a custom scheme name before saving.', canDelete: false };
  }

  if (isBuiltInTerminalColorSchemeName(definition.name)) {
    return {
      valid: false,
      message: 'Built-in presets are read-only. Save this under a new custom name.',
      canDelete: false,
    };
  }

  const missingField = TERMINAL_COLOR_SCHEME_FIELDS.find((field) => !definition[field.key]);
  if (missingField) {
    return {
      valid: false,
      message: `${missingField.label} cannot be empty.`,
      canDelete: false,
    };
  }

  const existingCustomScheme = findCustomTerminalColorScheme(settings, definition.name);
  return {
    valid: true,
    message: existingCustomScheme
      ? 'Saving will update this custom scheme.'
      : 'Saving will create a new custom scheme.',
    canDelete: existingCustomScheme !== null,
  };
}

function syncTerminalColorSchemeEditorActions(
  settings: MidTermSettingsPublic | null | undefined,
): void {
  const status = getTerminalColorSchemeEditorStatusElement();
  const saveButton = document.getElementById(
    'terminal-color-scheme-save',
  ) as HTMLButtonElement | null;
  const deleteButton = document.getElementById(
    'terminal-color-scheme-delete',
  ) as HTMLButtonElement | null;

  const validation = getTerminalColorSchemeEditorValidation(settings);
  if (status) {
    status.textContent = validation.message;
    status.classList.toggle('is-error', !validation.valid);
  }

  if (saveButton) {
    saveButton.disabled = !validation.valid;
  }

  if (deleteButton) {
    deleteButton.disabled = !validation.canDelete;
  }
}

function saveTerminalColorSchemeEditor(): void {
  const current = $currentSettings.get();
  const definition = readTerminalColorSchemeEditorDefinition();
  if (!current || !definition) {
    return;
  }

  const validation = getTerminalColorSchemeEditorValidation(current);
  if (!validation.valid) {
    syncTerminalColorSchemeEditorActions(current);
    return;
  }

  const existingIndex = current.terminalColorSchemes.findIndex(
    (scheme) => scheme.name.trim().toLowerCase() === definition.name.trim().toLowerCase(),
  );

  const nextSchemes = [...current.terminalColorSchemes];
  if (existingIndex >= 0) {
    nextSchemes[existingIndex] = definition;
  } else {
    nextSchemes.push(definition);
  }

  const nextSettings: MidTermSettingsPublic = {
    ...current,
    terminalColorScheme: definition.name,
    terminalColorSchemes: nextSchemes,
  };

  syncTerminalColorSchemeOptions(nextSettings);
  const select = document.getElementById(
    'setting-terminal-color-scheme',
  ) as HTMLSelectElement | null;
  if (select) {
    select.value = definition.name;
  }
  loadTerminalColorSchemeEditorFromSource(nextSettings, definition.name);
  persistSettingsSnapshot(current, nextSettings, nextSettings as MidTermSettingsUpdate);
}

function deleteTerminalColorSchemeEditorScheme(): void {
  const current = $currentSettings.get();
  const definition = readTerminalColorSchemeEditorDefinition();
  if (!current || !definition) {
    return;
  }

  const nextSchemes = current.terminalColorSchemes.filter(
    (scheme) => scheme.name.trim().toLowerCase() !== definition.name.trim().toLowerCase(),
  );

  const nextSettings: MidTermSettingsPublic = {
    ...current,
    terminalColorSchemes: nextSchemes,
    terminalColorScheme:
      current.terminalColorScheme.trim().toLowerCase() === definition.name.trim().toLowerCase()
        ? 'auto'
        : current.terminalColorScheme,
  };

  syncTerminalColorSchemeOptions(nextSettings);
  loadTerminalColorSchemeEditorFromSource(nextSettings, nextSettings.theme);
  persistSettingsSnapshot(current, nextSettings, nextSettings as MidTermSettingsUpdate);
}

function bindTerminalColorSchemeEditor(signal: AbortSignal): void {
  ensureTerminalColorSchemeEditorRendered();

  const sourceSelect = getTerminalColorSchemeEditorSourceSelect();
  const loadButton = document.getElementById('terminal-color-scheme-load');
  const resetButton = document.getElementById('terminal-color-scheme-reset');
  const saveButton = document.getElementById('terminal-color-scheme-save');
  const deleteButton = document.getElementById('terminal-color-scheme-delete');
  const nameInput = getTerminalColorSchemeEditorNameInput();
  const mainSelect = document.getElementById(
    'setting-terminal-color-scheme',
  ) as HTMLSelectElement | null;

  loadButton?.addEventListener(
    'click',
    () => {
      const current = $currentSettings.get();
      loadTerminalColorSchemeEditorFromSource(current, sourceSelect?.value ?? 'dark');
    },
    { signal },
  );

  resetButton?.addEventListener(
    'click',
    () => {
      const current = $currentSettings.get();
      loadTerminalColorSchemeEditorFromSource(current, '__blank__');
    },
    { signal },
  );

  saveButton?.addEventListener(
    'click',
    () => {
      saveTerminalColorSchemeEditor();
    },
    { signal },
  );

  deleteButton?.addEventListener(
    'click',
    () => {
      deleteTerminalColorSchemeEditorScheme();
    },
    { signal },
  );

  sourceSelect?.addEventListener(
    'change',
    () => {
      syncTerminalColorSchemeEditorActions($currentSettings.get());
    },
    { signal },
  );

  nameInput?.addEventListener(
    'input',
    () => {
      syncTerminalColorSchemeEditorActions($currentSettings.get());
    },
    { signal },
  );

  for (const field of TERMINAL_COLOR_SCHEME_FIELDS) {
    getTerminalColorSchemeEditorFieldInput(field.key)?.addEventListener(
      'input',
      () => {
        syncTerminalColorSchemeEditorActions($currentSettings.get());
      },
      { signal },
    );
  }

  mainSelect?.addEventListener(
    'change',
    () => {
      syncTerminalColorSchemeEditorSourceOptions($currentSettings.get(), mainSelect.value);
      syncTerminalColorSchemeEditorActions($currentSettings.get());
    },
    { signal },
  );
}

export function syncTerminalColorSchemeOptions(
  settings: MidTermSettingsPublic | null | undefined = $currentSettings.get(),
): void {
  const select = document.getElementById(
    'setting-terminal-color-scheme',
  ) as HTMLSelectElement | null;
  if (!select) {
    return;
  }

  const requestedValue = (settings?.terminalColorScheme ?? select.value) || 'auto';
  select.innerHTML = '';

  appendTranslatedOption(
    select,
    'auto',
    'settings.options.colorSchemeAuto',
    'Auto (follows theme)',
  );

  for (const definition of BUILT_IN_TERMINAL_COLOR_SCHEME_OPTIONS) {
    appendTranslatedOption(
      select,
      definition.value,
      definition.translationKey,
      definition.fallbackText,
    );
  }

  if ((settings?.terminalColorSchemes.length ?? 0) > 0) {
    const group = document.createElement('optgroup');
    group.label = 'Custom Schemes';

    for (const definition of settings?.terminalColorSchemes ?? []) {
      const option = document.createElement('option');
      option.value = definition.name;
      option.textContent = definition.name;
      group.appendChild(option);
    }

    select.appendChild(group);
  }

  select.value = Array.from(select.options).some((option) => option.value === requestedValue)
    ? requestedValue
    : 'auto';

  ensureTerminalColorSchemeEditorRendered();
  syncTerminalColorSchemeEditorSourceOptions(settings, select.value);

  const editorRoot = getTerminalColorSchemeEditorRoot();
  if (editorRoot?.dataset.initialized !== 'true') {
    const initialSource = select.value === 'auto' ? (settings?.theme ?? 'dark') : select.value;
    loadTerminalColorSchemeEditorFromSource(settings, initialSource);
  } else {
    syncTerminalColorSchemeEditorActions(settings);
  }
}

function updateBackgroundImageUi(settings: MidTermSettingsPublic): void {
  const preview = document.getElementById('background-image-preview') as HTMLImageElement | null;
  const empty = document.getElementById('background-image-empty');
  const name = document.getElementById('background-image-name');
  const removeBtn = document.getElementById('btn-background-remove') as HTMLButtonElement | null;
  const enabledCheckbox = document.getElementById(
    'setting-background-image-enabled',
  ) as HTMLInputElement | null;

  const hasImage = Boolean(
    settings.backgroundImageFileName && settings.backgroundImageRevision > 0,
  );

  if (preview) {
    if (hasImage) {
      preview.src = getBackgroundImageUrl(settings.backgroundImageRevision);
      preview.alt = settings.backgroundImageFileName ?? 'Background image';
      preview.classList.remove('hidden');
    } else {
      preview.removeAttribute('src');
      preview.alt = '';
      preview.classList.add('hidden');
    }
  }

  empty?.classList.toggle('hidden', hasImage);
  if (name) {
    name.textContent = hasImage ? (settings.backgroundImageFileName ?? '') : '';
  }
  if (removeBtn) {
    removeBtn.disabled = !hasImage;
  }
  if (enabledCheckbox) {
    enabledCheckbox.disabled = !hasImage;
    if (!hasImage) {
      enabledCheckbox.checked = false;
    }
  }
}

const ENVIRONMENT_VARIABLE_LINE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=.*$/;

function validateAgentEnvironmentInputs(): boolean {
  const textareas = [
    document.getElementById('setting-codex-env') as HTMLTextAreaElement | null,
    document.getElementById('setting-claude-env') as HTMLTextAreaElement | null,
  ];

  for (const textarea of textareas) {
    if (!textarea) {
      continue;
    }

    const invalidLine = textarea.value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !ENVIRONMENT_VARIABLE_LINE_PATTERN.test(line));

    if (invalidLine) {
      textarea.setCustomValidity(t('settings.behavior.agentEnvInvalid'));
      textarea.reportValidity();
      textarea.focus();
      return false;
    }

    textarea.setCustomValidity('');
  }

  return true;
}

async function handleBackgroundImageUpload(file: File): Promise<void> {
  try {
    const info = await uploadBackgroundImage(file);
    const current = $currentSettings.get();
    if (!current) return;

    const nextSettings = {
      ...current,
      backgroundImageEnabled: true,
      backgroundImageFileName: info.fileName ?? null,
      backgroundImageRevision: info.revision,
    };

    $currentSettings.set(nextSettings);
    updateBackgroundImageUi(nextSettings);
    applySettingsToTerminals();
  } catch (e) {
    log.error(() => `Background image upload failed: ${String(e)}`);
  }
}

async function handleBackgroundImageDelete(): Promise<void> {
  try {
    const info = await deleteBackgroundImage();
    const current = $currentSettings.get();
    if (!current) return;

    const nextSettings = {
      ...current,
      backgroundImageEnabled: false,
      backgroundImageFileName: info.fileName ?? null,
      backgroundImageRevision: info.revision,
    };

    $currentSettings.set(nextSettings);
    updateBackgroundImageUi(nextSettings);
    applySettingsToTerminals();
  } catch (e) {
    log.error(() => `Background image delete failed: ${String(e)}`);
  }
}

/**
 * Bind the secret dev mode toggle to the server version value.
 * Click 7 times to toggle dev mode on/off.
 */
export function bindDevModeToggle(): void {
  const el = document.getElementById('version-server');
  if (!el) return;

  let clicks = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  el.style.cursor = 'default';
  el.addEventListener('click', () => {
    clicks++;
    clearTimeout(timer);

    if (clicks >= 7) {
      clicks = 0;
      const settings = $currentSettings.get();
      if (!settings) return;
      const newDevMode = !settings.devMode;
      const updated = { ...settings, devMode: newDevMode };
      $currentSettings.set(updated);
      setDevMode(newDevMode);
      updateSettings(updated as Parameters<typeof updateSettings>[0]).catch(() => {});
      const envRow = document.getElementById('dev-environment-row');
      const envEl = document.getElementById('dev-environment-name');
      if (envRow && envEl) {
        envRow.style.display = newDevMode ? '' : 'none';
        envEl.textContent = 'DEV';
      }
    }

    timer = setTimeout(() => {
      clicks = 0;
    }, 2000);
  });
}
