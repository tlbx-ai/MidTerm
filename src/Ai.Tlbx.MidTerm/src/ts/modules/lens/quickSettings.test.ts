import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/client', () => ({
  updateSettings: vi.fn().mockResolvedValue({ response: { ok: true } }),
}));

import type { MidTermSettingsPublic } from '../../api/types';
import { updateSettings } from '../../api/client';
import { $currentSettings, $sessions } from '../../stores';
import {
  getLensQuickSettingsDraft,
  removeLensQuickSettingsSessionState,
  setLensQuickSettingsDraft,
} from './quickSettings';

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.has(key) ? values.get(key)! : null;
    },
    key(index) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

function createSettings(
  patch: Partial<MidTermSettingsPublic> = {},
): MidTermSettingsPublic {
  return {
    codexYoloDefault: false,
    codexDefaultLensModel: '',
    codexEnvironmentVariables: '',
    claudeDangerouslySkipPermissionsDefault: false,
    claudeDefaultLensModel: '',
    claudeEnvironmentVariables: '',
    ...patch,
  } as MidTermSettingsPublic;
}

describe('lens quick settings', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createMemoryStorage());
    globalThis.localStorage.clear();
    $sessions.set({});
    $currentSettings.set(createSettings());
    vi.mocked(updateSettings).mockClear();
  });

  afterEach(() => {
    removeLensQuickSettingsSessionState('codex-default');
    removeLensQuickSettingsSessionState('codex-save');
    $sessions.set({});
    globalThis.localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('defaults new codex drafts to gpt-5.4 when no stored model exists', () => {
    $sessions.set({
      'codex-default': {
        id: 'codex-default',
        profileHint: 'codex',
      } as never,
    });

    expect(getLensQuickSettingsDraft('codex-default').model).toBe('gpt-5.4');
  });

  it('persists the selected provider model into MidTerm settings', () => {
    $sessions.set({
      'codex-save': {
        id: 'codex-save',
        profileHint: 'codex',
      } as never,
    });

    setLensQuickSettingsDraft('codex-save', { model: 'gpt-5.4-codex' });

    expect($currentSettings.get()?.codexDefaultLensModel).toBe('gpt-5.4-codex');
    expect(vi.mocked(updateSettings)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(updateSettings).mock.calls[0]?.[0]).toMatchObject({
      codexDefaultLensModel: 'gpt-5.4-codex',
    });
  });
});
