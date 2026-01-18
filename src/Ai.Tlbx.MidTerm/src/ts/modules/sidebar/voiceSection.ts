/**
 * Voice Section Module
 *
 * Handles the collapsible "Voice Assistant" section
 * in the sidebar footer.
 */

import { createLogger } from '../logging';

const log = createLogger('voiceSection');
const STORAGE_KEY = 'midterm.voiceSectionCollapsed';

let voiceSectionVisible = false;
let devModeEnabled = false;

/**
 * Show/hide the voice section based on voice server availability
 */
export function setVoiceSectionVisible(visible: boolean): void {
  voiceSectionVisible = visible;
  log.info(() => `Voice server available: ${visible}`);
}

/**
 * Set dev mode - shows the sync button for diagnostics
 */
export function setDevMode(enabled: boolean): void {
  devModeEnabled = enabled;
  const syncBtn = document.getElementById('btn-voice-sync');
  if (syncBtn) {
    syncBtn.classList.toggle('hidden', !enabled);
  }
  log.info(() => `DevMode=${enabled}`);
}

/**
 * Check if dev mode is enabled
 */
export function isDevMode(): boolean {
  return devModeEnabled;
}

/**
 * Get current voice section visibility
 */
export function isVoiceSectionVisible(): boolean {
  return voiceSectionVisible;
}

/**
 * Initialize the voice section collapse/expand behavior
 */
export function initVoiceSection(): void {
  const section = document.getElementById('voice-section');
  const toggleBtn = document.getElementById('btn-toggle-voice');

  if (!section || !toggleBtn) {
    log.info(() => 'Voice section elements not found');
    return;
  }

  const isCollapsed = localStorage.getItem(STORAGE_KEY) === 'true';
  if (isCollapsed) {
    section.classList.add('collapsed');
  }

  toggleBtn.addEventListener('click', () => {
    const nowCollapsed = section.classList.toggle('collapsed');
    localStorage.setItem(STORAGE_KEY, String(nowCollapsed));
    log.info(() => `Voice section ${nowCollapsed ? 'collapsed' : 'expanded'}`);
  });

  log.info(() => `Voice section initialized (collapsed=${isCollapsed})`);
}

/**
 * Update the voice status text
 */
export function setVoiceStatus(status: string): void {
  const statusEl = document.getElementById('voice-status');
  if (statusEl) {
    statusEl.textContent = status;
  }
}

/**
 * Set mic button active state
 */
export function setMicActive(active: boolean): void {
  const micBtn = document.getElementById('btn-voice-mic');
  if (micBtn) {
    micBtn.classList.toggle('active', active);
  }
}

/**
 * Set toggle button enabled state
 */
export function setToggleEnabled(enabled: boolean): void {
  const toggleBtn = document.getElementById('btn-voice-toggle') as HTMLButtonElement | null;
  if (toggleBtn) {
    toggleBtn.disabled = !enabled;
  }
}

/**
 * Set toggle button recording state
 */
export function setToggleRecording(recording: boolean): void {
  const toggleBtn = document.getElementById('btn-voice-toggle');
  if (toggleBtn) {
    toggleBtn.classList.toggle('recording', recording);
    const icon = toggleBtn.querySelector('.icon');
    if (icon) {
      // &#xe912; is play, &#xe996; is stop
      icon.innerHTML = recording ? '&#xe996;' : '&#xe912;';
    }
  }
}
