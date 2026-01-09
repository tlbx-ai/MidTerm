/**
 * Settings Tab Navigation
 *
 * Manages the tabbed interface for the settings panel.
 */

export type SettingsTab = 'general' | 'appearance' | 'behavior' | 'security' | 'diagnostics';

const STORAGE_KEY = 'settings-tab';
const DEFAULT_TAB: SettingsTab = 'general';
const VALID_TABS: SettingsTab[] = ['general', 'appearance', 'behavior', 'security', 'diagnostics'];

let activeTab: SettingsTab = DEFAULT_TAB;
let initialized = false;

export function initSettingsTabs(): void {
  if (initialized) {
    restoreLastTab();
    return;
  }

  bindTabEvents();
  restoreLastTab();
  initialized = true;
}

export function switchSettingsTab(tab: SettingsTab): void {
  if (!isValidTab(tab)) return;

  activeTab = tab;
  localStorage.setItem(STORAGE_KEY, tab);

  document.querySelectorAll('.settings-tab').forEach((btn) => {
    const isActive = btn.getAttribute('data-tab') === tab;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', String(isActive));
  });

  document.querySelectorAll('.settings-panel').forEach((panel) => {
    const isActive = panel.getAttribute('data-panel') === tab;
    panel.classList.toggle('hidden', !isActive);
  });
}

export function getActiveSettingsTab(): SettingsTab {
  return activeTab;
}

function bindTabEvents(): void {
  document.querySelectorAll('.settings-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-tab') as SettingsTab;
      if (tab) switchSettingsTab(tab);
    });
  });
}

function restoreLastTab(): void {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved && isValidTab(saved)) {
    switchSettingsTab(saved as SettingsTab);
  } else {
    switchSettingsTab(DEFAULT_TAB);
  }
}

function isValidTab(tab: string): tab is SettingsTab {
  return VALID_TABS.includes(tab as SettingsTab);
}
