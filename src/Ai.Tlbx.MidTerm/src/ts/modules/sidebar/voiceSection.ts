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
let voiceChatEnabled = false;
const devModeListeners = new Set<(enabled: boolean) => void>();

/**
 * Mirrors backend voice capability into the footer so experimental voice UI is
 * only exposed when the runtime can actually service it.
 */
export function setVoiceChatEnabled(enabled: boolean): void {
  voiceChatEnabled = enabled;
  const section = document.getElementById('voice-section');
  if (section) {
    section.classList.toggle('hidden', !enabled);
  }
  log.info(() => `VoiceChat feature: ${enabled ? 'enabled' : 'disabled'}`);
}

/** Exposes the shared voice-capability flag to modules that gate voice UX. */
export function isVoiceChatEnabled(): boolean {
  return voiceChatEnabled;
}

/**
 * Tracks whether the voice backend is currently reachable so the UI can tell
 * "feature disabled" apart from "feature enabled but service missing".
 */
export function setVoiceSectionVisible(visible: boolean): void {
  voiceSectionVisible = visible;
  log.info(() => `Voice server available: ${visible}`);
}

/**
 * Propagates dev mode immediately because several Lens and voice affordances
 * are intentionally hidden from normal users until the UX settles.
 */
export function setDevMode(enabled: boolean): void {
  devModeEnabled = enabled;
  const syncBtn = document.getElementById('btn-voice-sync');
  if (syncBtn) {
    syncBtn.classList.toggle('hidden', !enabled);
  }
  for (const listener of devModeListeners) {
    listener(enabled);
  }
  log.info(() => `DevMode=${enabled}`);
}

/** Shared source of truth for dev-only frontend affordances. */
export function isDevMode(): boolean {
  return devModeEnabled;
}

/**
 * Lets experimental surfaces react to the hidden dev-mode toggle without
 * waiting for a reload, which keeps gating behavior predictable while iterating.
 */
export function onDevModeChanged(listener: (enabled: boolean) => void): () => void {
  devModeListeners.add(listener);
  return () => {
    devModeListeners.delete(listener);
  };
}

/** Exposes live voice-section visibility to modules that coordinate footer UX. */
export function isVoiceSectionVisible(): boolean {
  return voiceSectionVisible;
}

/**
 * Persists the voice footer's collapsed state because this part of the sidebar
 * carries operational tools that users often want minimized between sessions.
 */
export function initVoiceSection(): void {
  const section = document.getElementById('voice-section');
  const toggleBtn = document.getElementById('btn-toggle-voice');

  if (!section || !toggleBtn) {
    log.info(() => 'Voice section elements not found');
    return;
  }

  const isCollapsed = localStorage.getItem(STORAGE_KEY) !== 'false';
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

/** Keeps the footer status line aligned with the current voice lifecycle step. */
export function setVoiceStatus(status: string): void {
  const statusEl = document.getElementById('voice-status');
  if (statusEl) {
    statusEl.textContent = status;
  }
}

/** Reflects recording state in the footer so the voice toggle never lies about capture. */
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
