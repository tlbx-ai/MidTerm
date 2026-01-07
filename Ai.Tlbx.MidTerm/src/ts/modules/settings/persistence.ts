/**
 * Settings Persistence Module
 *
 * Handles loading, saving, and form binding for application settings.
 * Communicates with the server API to persist settings changes.
 */

import type { Settings, ThemeName, TerminalState, HealthResponse } from '../../types';
import { THEMES, TERMINAL_FONT_STACK, JS_BUILD_VERSION } from '../../constants';
import { currentSettings, setCurrentSettings, dom, sessionTerminals } from '../../state';
import { setCookie } from '../../utils';

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
export function populateVersionInfo(serverVersion: string | null, hostVersion: string | null, frontendVersion: string): void {
  const formatVersion = (v: string) => 'v' + (v.split(/[+-]/)[0] ?? v);

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
}

/**
 * Populate user dropdown for run-as-user selection
 */
export function populateUserDropdown(
  users: Array<{ username: string }>,
  selectedUser: string | null
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
export function populateSettingsForm(settings: Settings): void {
  setElementValue('setting-default-shell', settings.defaultShell || 'Pwsh');
  setElementValue('setting-working-dir', settings.defaultWorkingDirectory || '');
  setElementValue('setting-font-size', settings.fontSize || 14);
  setElementValue('setting-font-family', settings.fontFamily || 'Cascadia Code');
  setElementValue('setting-cursor-style', settings.cursorStyle || 'bar');
  setElementChecked('setting-cursor-blink', settings.cursorBlink !== false);
  setElementValue('setting-theme', settings.theme || 'dark');
  setElementValue('setting-contrast', String(settings.minimumContrastRatio || 1));
  setElementValue('setting-scrollback', settings.scrollbackLines || 10000);
  setElementValue('setting-bell-style', settings.bellStyle || 'notification');
  setElementChecked('setting-copy-on-select', settings.copyOnSelect === true);
  setElementChecked('setting-right-click-paste', settings.rightClickPaste !== false);
  setElementValue('setting-clipboard-shortcuts', settings.clipboardShortcuts || 'auto');
  setElementChecked('setting-smooth-scrolling', settings.smoothScrolling === true);
  setElementChecked('setting-webgl', settings.useWebGL !== false);
  setElementValue('setting-run-as-user', settings.runAsUser || '');
  setElementChecked('setting-debug-logging', settings.debugLogging === true);
}

/**
 * Fetch settings, users, version, and health from server and populate the form
 */
export async function fetchSettings(): Promise<void> {
  try {
    const [settings, users, version, health] = await Promise.all([
      fetch('/api/settings').then((r) => r.json() as Promise<Settings>),
      fetch('/api/users')
        .then((r) => r.json() as Promise<Array<{ username: string }>>)
        .catch(() => [] as Array<{ username: string }>),
      fetch('/api/version')
        .then((r) => r.text())
        .catch(() => null),
      fetch('/api/health')
        .then((r) => r.json() as Promise<HealthResponse>)
        .catch(() => ({ status: '', memoryMB: 0, uptime: '', sessionCount: 0, ttyHostVersion: undefined }))
    ]);

    setCurrentSettings(settings);
    populateUserDropdown(users, settings.runAsUser);
    populateSettingsForm(settings);
    populateVersionInfo(version, health.ttyHostVersion ?? null, JS_BUILD_VERSION);

    // Apply settings to any terminals that were created before settings loaded
    applySettingsToTerminals();
  } catch (e) {
    console.error('Error fetching settings:', e);
  }
}

/**
 * Apply current settings to all open terminals
 */
function applySettingsToTerminals(): void {
  if (!currentSettings) return;
  const settings = currentSettings;

  const theme = THEMES[settings.theme] || THEMES.dark;
  const fontFamily = `'${settings.fontFamily || 'Cascadia Code'}', ${TERMINAL_FONT_STACK}`;

  sessionTerminals.forEach((state: TerminalState) => {
    state.terminal.options.cursorBlink = settings.cursorBlink;
    state.terminal.options.cursorStyle = settings.cursorStyle;
    state.terminal.options.fontFamily = fontFamily;
    state.terminal.options.fontSize = settings.fontSize;
    state.terminal.options.theme = theme;
    state.terminal.options.minimumContrastRatio = settings.minimumContrastRatio;
    state.terminal.options.smoothScrollDuration = settings.smoothScrolling ? 150 : 0;

    // Trigger re-render after font changes
    if (state.opened) {
      try {
        const dims = state.fitAddon.proposeDimensions();
        if (dims?.cols && dims?.rows) {
          state.fitAddon.fit();
        }
      } catch {
        // FitAddon may fail if terminal render service isn't initialized
      }
    }
  });
}

/**
 * Save all settings to the server
 */
export function saveAllSettings(): void {
  const runAsUserValue = getElementValue('setting-run-as-user', '');
  const settings: Settings = {
    defaultShell: getElementValue('setting-default-shell', 'Pwsh'),
    defaultCols: currentSettings?.defaultCols ?? 120,
    defaultRows: currentSettings?.defaultRows ?? 30,
    defaultWorkingDirectory: getElementValue('setting-working-dir', ''),
    fontSize: parseInt(getElementValue('setting-font-size', '14'), 10) || 14,
    fontFamily: getElementValue('setting-font-family', 'Cascadia Code'),
    cursorStyle: getElementValue('setting-cursor-style', 'bar') as Settings['cursorStyle'],
    cursorBlink: getElementChecked('setting-cursor-blink'),
    theme: getElementValue('setting-theme', 'dark') as ThemeName,
    minimumContrastRatio: parseFloat(getElementValue('setting-contrast', '1')) || 1,
    smoothScrolling: getElementChecked('setting-smooth-scrolling'),
    useWebGL: getElementChecked('setting-webgl'),
    scrollbackLines: parseInt(getElementValue('setting-scrollback', '10000'), 10) || 10000,
    bellStyle: getElementValue('setting-bell-style', 'notification') as Settings['bellStyle'],
    copyOnSelect: getElementChecked('setting-copy-on-select'),
    rightClickPaste: getElementChecked('setting-right-click-paste'),
    clipboardShortcuts: getElementValue(
      'setting-clipboard-shortcuts',
      'auto'
    ) as Settings['clipboardShortcuts'],
    runAsUser: runAsUserValue || null,
    debugLogging: getElementChecked('setting-debug-logging')
  };

  setCookie('mm-theme', settings.theme);

  fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings)
  })
    .then((r) => {
      if (r.ok) {
        setCurrentSettings(settings);
        const theme = THEMES[settings.theme] || THEMES.dark;
        document.documentElement.style.setProperty('--terminal-bg', theme.background);
        applySettingsToTerminals();
      }
    })
    .catch((e) => {
      console.error('Error saving settings:', e);
    });
}

/**
 * Bind auto-save behavior to settings form elements
 */
export function bindSettingsAutoSave(): void {
  const settingsView = dom.settingsView;
  if (!settingsView) return;

  settingsView.querySelectorAll('select, input[type="checkbox"]').forEach((el) => {
    el.addEventListener('change', saveAllSettings);
  });

  settingsView.querySelectorAll('.text-input-wrapper').forEach((wrapper) => {
    const input = wrapper.querySelector('input') as HTMLInputElement | null;
    const saveBtn = wrapper.querySelector('.inline-save-btn') as HTMLButtonElement | null;
    if (!input || !saveBtn) return;

    let originalValue = '';

    input.addEventListener('focus', () => {
      originalValue = input.value;
    });

    input.addEventListener('input', () => {
      wrapper.classList.toggle('unsaved', input.value !== originalValue);
    });

    saveBtn.addEventListener('click', () => {
      saveAllSettings();
      wrapper.classList.remove('unsaved');
      originalValue = input.value;
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveAllSettings();
        wrapper.classList.remove('unsaved');
        originalValue = input.value;
      }
    });
  });
}
