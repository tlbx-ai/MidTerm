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
  UserInfo,
  ThemeSetting,
  CursorStyleSetting,
  CursorInactiveStyleSetting,
  BellStyleSetting,
  ClipboardShortcutsSetting,
  TabTitleModeSetting,
  ScrollbarStyleSetting,
  TerminalColorSchemeSetting,
} from '../../api/types';
import { TERMINAL_FONT_STACK, JS_BUILD_VERSION } from '../../constants';
import { applyCssTheme } from '../theming/cssThemes';
import { applyBackgroundAppearance, getBackgroundImageUrl } from '../theming/backgroundAppearance';
import { getEffectiveXtermTheme } from '../theming/themes';
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
import { rescaleAllTerminalsImmediate } from '../terminal/scaling';
import {
  applyTerminalScrollbarStyleClass,
  normalizeScrollbarStyle,
} from '../terminal/scrollbarStyle';
import { setLocale, t } from '../i18n';
import type { LanguageSetting } from '../../api/types';
import { renderUpdatePanel } from '../updating/checker';
import { createLogger } from '../logging';

const log = createLogger('settings');

// AbortController for settings event listeners cleanup
let settingsAbortController: AbortController | null = null;

/**
 * Set the value of a form element by ID
 */
export function setElementValue(id: string, value: string | number): void {
  const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
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
  const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
  return el ? el.value : defaultValue;
}

/**
 * Get the checked state of a checkbox by ID
 */
export function getElementChecked(id: string): boolean {
  const el = document.getElementById(id) as HTMLInputElement | null;
  return el ? el.checked : false;
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
}

/**
 * Populate the settings form with current settings
 */
export function populateSettingsForm(settings: MidTermSettingsPublic): void {
  setElementValue('setting-default-shell', settings.defaultShell ?? 'Pwsh');
  setElementValue('setting-working-dir', settings.defaultWorkingDirectory);
  setElementValue('setting-font-size', settings.fontSize);
  setElementValue('setting-font-family', settings.fontFamily);
  setElementValue('setting-cursor-style', settings.cursorStyle);
  setElementChecked('setting-cursor-blink', settings.cursorBlink);
  setElementValue('setting-cursor-inactive', settings.cursorInactiveStyle);
  setElementChecked('setting-hide-cursor-on-input-bursts', settings.hideCursorOnInputBursts);
  setElementValue('setting-theme', settings.theme);
  setElementValue('setting-terminal-color-scheme', settings.terminalColorScheme);
  setElementChecked('setting-background-image-enabled', settings.backgroundImageEnabled);
  setElementValue('setting-background-fit', settings.backgroundImageFit);
  setElementValue('setting-ui-transparency', settings.uiTransparency);
  setElementValue('setting-tab-title', settings.tabTitleMode);
  setElementValue('setting-contrast', String(settings.minimumContrastRatio));
  setElementValue('setting-scrollback', settings.scrollbackLines);
  setElementValue('setting-bell-style', settings.bellStyle);
  setElementChecked('setting-copy-on-select', settings.copyOnSelect);
  setElementChecked('setting-right-click-paste', settings.rightClickPaste);
  setElementValue('setting-clipboard-shortcuts', settings.clipboardShortcuts);
  setElementValue('setting-terminal-enter-mode', settings.terminalEnterMode);
  setElementChecked('setting-smooth-scrolling', settings.smoothScrolling);
  setElementValue('setting-scrollbar-style', settings.scrollbarStyle);
  setElementChecked('setting-webgl', settings.useWebGL);
  setElementChecked('setting-scrollback-protection', settings.scrollbackProtection);
  setElementValue('setting-input-mode', settings.inputMode);
  setElementChecked('setting-file-radar', settings.fileRadar);
  setElementChecked('setting-manager-bar', settings.managerBarEnabled);
  setElementChecked('setting-tmux-compatibility', settings.tmuxCompatibility);
  setElementChecked('setting-ide-mode', settings.ideMode);
  setElementChecked('setting-changelog-after-update', settings.showChangelogAfterUpdate);
  setElementChecked('setting-show-update-notification', settings.showUpdateNotification);
  setElementValue('setting-update-channel', settings.updateChannel);
  setElementValue('setting-language', settings.language);
  setElementValue('setting-run-as-user', settings.runAsUser ?? '');
  updateTransparencyValue(settings.uiTransparency);
  updateBackgroundImageUi(settings);
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
export function applySettingsToTerminals(): void {
  const settings = $currentSettings.get();
  if (!settings) return;

  applyBackgroundAppearance(settings);
  const theme = getEffectiveXtermTheme();
  const fontFamily = `'${settings.fontFamily}', ${TERMINAL_FONT_STACK}`;
  const fontSize = getEffectiveTerminalFontSize(settings.fontSize);
  const contrastRatio = settings.minimumContrastRatio;

  const scrollbarStyle = normalizeScrollbarStyle(settings.scrollbarStyle);

  sessionTerminals.forEach((state: TerminalState) => {
    state.terminal.options.cursorBlink = settings.cursorBlink;
    state.terminal.options.cursorStyle = settings.cursorStyle;
    state.terminal.options.cursorInactiveStyle = settings.cursorInactiveStyle;
    state.terminal.options.fontFamily = fontFamily;
    state.terminal.options.fontSize = fontSize;
    state.terminal.options.theme = theme;
    state.terminal.options.minimumContrastRatio = contrastRatio;
    state.terminal.options.smoothScrollDuration = settings.smoothScrolling ? 150 : 0;
    state.terminal.options.scrollback = settings.scrollbackLines;

    applyTerminalScrollbarStyleClass(state.container, scrollbarStyle);

    if (!settings.hideCursorOnInputBursts && state.burstCursorHidden) {
      if (state.burstCursorRestoreTimer != null) {
        clearTimeout(state.burstCursorRestoreTimer);
        state.burstCursorRestoreTimer = null;
      }
      state.burstCursorHidden = false;
      if (state.remoteCursorVisible !== false) {
        state.terminal.write('\x1b[?25h');
      }
    }
  });

  rescaleAllTerminalsImmediate();
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
  const runAsUserValue = getElementValue('setting-run-as-user', '');
  const prevSettings = $currentSettings.get();
  const prevDefaultCols = prevSettings?.defaultCols ?? 120;
  const prevDefaultRows = prevSettings?.defaultRows ?? 30;

  const defaultShellValue = getElementValue('setting-default-shell', 'Pwsh');
  const validShells = ['Pwsh', 'PowerShell', 'Cmd', 'Bash', 'Zsh'];
  const defaultShell = validShells.includes(defaultShellValue)
    ? (defaultShellValue as 'Pwsh' | 'PowerShell' | 'Cmd' | 'Bash' | 'Zsh')
    : null;

  const settings: MidTermSettingsUpdate = {
    defaultShell,
    defaultCols: prevDefaultCols,
    defaultRows: prevDefaultRows,
    defaultWorkingDirectory: getElementValue('setting-working-dir', ''),
    fontSize: parseInt(getElementValue('setting-font-size', '14'), 10) || 14,
    fontFamily: getElementValue('setting-font-family', 'Cascadia Code'),
    cursorStyle: getElementValue('setting-cursor-style', 'block') as CursorStyleSetting,
    cursorBlink: getElementChecked('setting-cursor-blink'),
    hideCursorOnInputBursts: getElementChecked('setting-hide-cursor-on-input-bursts'),
    cursorInactiveStyle: getElementValue(
      'setting-cursor-inactive',
      'none',
    ) as CursorInactiveStyleSetting,
    theme: getElementValue('setting-theme', 'dark') as ThemeSetting,
    terminalColorScheme: getElementValue(
      'setting-terminal-color-scheme',
      'auto',
    ) as TerminalColorSchemeSetting,
    backgroundImageEnabled: getElementChecked('setting-background-image-enabled'),
    backgroundImageFileName: prevSettings?.backgroundImageFileName ?? null,
    backgroundImageRevision: prevSettings?.backgroundImageRevision ?? 0,
    backgroundImageFit: getElementValue('setting-background-fit', 'cover'),
    uiTransparency: parseInt(getElementValue('setting-ui-transparency', '0'), 10) || 0,
    tabTitleMode: getElementValue('setting-tab-title', 'hostname') as TabTitleModeSetting,
    minimumContrastRatio: parseFloat(getElementValue('setting-contrast', '1')) || 1,
    smoothScrolling: getElementChecked('setting-smooth-scrolling'),
    scrollbarStyle: getElementValue('setting-scrollbar-style', 'off') as ScrollbarStyleSetting,
    useWebGL: getElementChecked('setting-webgl'),
    scrollbackLines: parseInt(getElementValue('setting-scrollback', '10000'), 10) || 10000,
    bellStyle: getElementValue('setting-bell-style', 'notification') as BellStyleSetting,
    copyOnSelect: getElementChecked('setting-copy-on-select'),
    rightClickPaste: getElementChecked('setting-right-click-paste'),
    clipboardShortcuts: getElementValue(
      'setting-clipboard-shortcuts',
      'auto',
    ) as ClipboardShortcutsSetting,
    terminalEnterMode: getElementValue(
      'setting-terminal-enter-mode',
      'default',
    ) as MidTermSettingsUpdate['terminalEnterMode'],
    scrollbackProtection: getElementChecked('setting-scrollback-protection'),
    inputMode: getElementValue('setting-input-mode', 'keyboard'),
    fileRadar: getElementChecked('setting-file-radar'),
    managerBarEnabled: getElementChecked('setting-manager-bar'),
    managerBarButtons: prevSettings?.managerBarButtons ?? [],
    devMode: prevSettings?.devMode ?? false,
    tmuxCompatibility: getElementChecked('setting-tmux-compatibility'),
    ideMode: getElementChecked('setting-ide-mode'),
    showChangelogAfterUpdate: getElementChecked('setting-changelog-after-update'),
    showUpdateNotification: getElementChecked('setting-show-update-notification'),
    updateChannel: getElementValue('setting-update-channel', 'stable'),
    language: getElementValue('setting-language', 'auto') as LanguageSetting,
    runAsUser: runAsUserValue || null,
  };

  setCookie('mm-theme', settings.theme);

  setCookie('mm-language', settings.language);

  updateSettings(settings)
    .then(({ response, error }) => {
      if (response.ok) {
        if (prevSettings) {
          $currentSettings.set({ ...prevSettings, ...settings });
        }
        applyCssTheme(settings.theme);
        applySettingsToTerminals();
        updateTabTitle();
        void setLocale(settings.language);
      } else {
        log.error(() => `Settings save failed: ${response.status} ${String(error)}`);
      }
    })
    .catch((e: unknown) => {
      log.error(() => `Error saving settings: ${String(e)}`);
    });
}

/**
 * Bind auto-save behavior to settings form elements.
 * Uses AbortController for cleanup when settings panel closes.
 */
export function bindSettingsAutoSave(): void {
  // Clean up previous listeners first
  unbindSettingsAutoSave();

  const settingsView = dom.settingsView;
  if (!settingsView) return;

  settingsAbortController = new AbortController();
  const { signal } = settingsAbortController;

  settingsView.querySelectorAll('select, input[type="checkbox"]').forEach((el) => {
    el.addEventListener('change', saveAllSettings, { signal });
  });

  settingsView.querySelectorAll('input[type="range"]').forEach((el) => {
    el.addEventListener('change', saveAllSettings, { signal });
  });

  const transparencySlider = document.getElementById(
    'setting-ui-transparency',
  ) as HTMLInputElement | null;
  if (transparencySlider) {
    transparencySlider.addEventListener(
      'input',
      () => {
        const value = parseInt(transparencySlider.value, 10) || 0;
        updateTransparencyValue(value);
        const current = $currentSettings.get();
        if (!current) return;
        applyBackgroundAppearance({ ...current, uiTransparency: value });
      },
      { signal },
    );
  }

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

  settingsView.querySelectorAll('.text-input-wrapper').forEach((wrapper) => {
    const input = wrapper.querySelector('input');
    const saveBtn = wrapper.querySelector('.inline-save-btn');
    if (!input || !saveBtn) return;

    let originalValue = '';

    input.addEventListener(
      'focus',
      () => {
        originalValue = input.value;
      },
      { signal },
    );

    input.addEventListener(
      'input',
      () => {
        wrapper.classList.toggle('unsaved', input.value !== originalValue);
      },
      { signal },
    );

    saveBtn.addEventListener(
      'click',
      () => {
        saveAllSettings();
        wrapper.classList.remove('unsaved');
        originalValue = input.value;
      },
      { signal },
    );

    input.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          saveAllSettings();
          wrapper.classList.remove('unsaved');
          originalValue = input.value;
        }
      },
      { signal },
    );
  });
}

/**
 * Clean up settings event listeners
 */
export function unbindSettingsAutoSave(): void {
  if (settingsAbortController) {
    settingsAbortController.abort();
    settingsAbortController = null;
  }
}

function updateTransparencyValue(value: number): void {
  const label = document.getElementById('setting-ui-transparency-value');
  if (label) {
    label.textContent = `${String(value)}%`;
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
