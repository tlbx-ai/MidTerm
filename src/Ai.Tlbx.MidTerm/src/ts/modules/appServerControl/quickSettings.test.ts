import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/client', () => ({
  updateSettings: vi.fn().mockResolvedValue({ response: { ok: true } }),
}));

import { updateSettings } from '../../api/client';
import type { MidTermSettingsPublic } from '../../api/types';
import { $currentSettings, $sessions } from '../../stores';
import {
  createAppServerControlTurnRequestWithQuickSettings,
  getAppServerControlQuickSettingsDraft,
  removeAppServerControlQuickSettingsSessionState,
  setAppServerControlQuickSettingsDraft,
  syncAppServerControlQuickSettingsFromSnapshot,
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

function createSettings(patch: Partial<MidTermSettingsPublic> = {}): MidTermSettingsPublic {
  return {
    codexYoloDefault: false,
    codexDefaultAppServerControlModel: '',
    codexEnvironmentVariables: '',
    ...patch,
  } as MidTermSettingsPublic;
}

describe('appServerControl quick settings', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createMemoryStorage());
    globalThis.localStorage.clear();
    $sessions.set({});
    $currentSettings.set(createSettings());
    vi.mocked(updateSettings).mockClear();
  });

  afterEach(() => {
    removeAppServerControlQuickSettingsSessionState('codex-default');
    removeAppServerControlQuickSettingsSessionState('codex-save');
    removeAppServerControlQuickSettingsSessionState('grok-stale');
    $sessions.set({});
    globalThis.localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('retains native Claude settings when the session profile is Claude', () => {
    $sessions.set({ 'grok-stale': { id: 'grok-stale', profileHint: 'claude' } } as any);
    syncAppServerControlQuickSettingsFromSnapshot('grok-stale', 'claude', {
      model: 'haiku',
      effort: 'low',
    });
    expect(getAppServerControlQuickSettingsDraft('grok-stale').model).toBe('haiku');
    expect(getAppServerControlQuickSettingsDraft('grok-stale').effort).toBe('low');
  });

  it('clears unsupported effort when switching native models and deep-clones their catalogues', () => {
    $sessions.set({ 'grok-stale': { id: 'grok-stale', profileHint: 'claude' } } as any);
    syncAppServerControlQuickSettingsFromSnapshot('grok-stale', 'claude', {
      model: 'opus',
      effort: 'high',
      modelOptions: [
        { value: 'opus', label: 'Opus', effortOptions: [{ value: 'high', label: 'High' }] },
        { value: 'haiku', label: 'Haiku', effortOptions: [] },
      ],
    });
    const draft = getAppServerControlQuickSettingsDraft('grok-stale');
    draft.modelOptions![0]!.effortOptions![0]!.label = 'Changed copy';
    expect(
      getAppServerControlQuickSettingsDraft('grok-stale').modelOptions![0]!.effortOptions![0]!
        .label,
    ).toBe('High');
    setAppServerControlQuickSettingsDraft('grok-stale', { model: 'haiku' });
    expect(getAppServerControlQuickSettingsDraft('grok-stale').effort).toBeNull();
  });

  it('sends changed native settings with opaque empty and boolean values and isolates returned drafts', () => {
    const id = 'grok-stale';
    syncAppServerControlQuickSettingsFromSnapshot(id, 'grok', {
      configOptions: [
        {
          configId: 'agent',
          name: 'Agent',
          type: 'select',
          currentValue: 'reviewer',
          options: [
            {
              name: 'Agents',
              options: [
                { value: '', name: 'Default' },
                { value: 'reviewer', name: 'Reviewer' },
              ],
            },
          ],
        },
        { configId: 'concise', name: 'Concise', type: 'boolean', currentValue: false },
      ],
    });
    const draft = getAppServerControlQuickSettingsDraft(id);
    const options = draft.configOptions!;
    options[0]!.currentValue = '';
    options[1]!.currentValue = true;
    expect(getAppServerControlQuickSettingsDraft(id).configOptions![0]!.currentValue).toBe(
      'reviewer',
    );
    setAppServerControlQuickSettingsDraft(id, { configOptions: options });
    expect(createAppServerControlTurnRequestWithQuickSettings(id, 'Inspect').configValues).toEqual({
      agent: '',
      concise: true,
    });
  });

  it('refreshes native choices while preserving valid pending edits and discarding removed choices', () => {
    const id = 'grok-stale';
    const options = [
      {
        configId: 'agent',
        name: 'Agent',
        type: 'select',
        currentValue: '',
        options: [
          { value: '', name: 'Default' },
          { value: 'reviewer', name: 'Reviewer' },
        ],
      },
      { configId: 'concise', name: 'Concise', type: 'boolean', currentValue: false },
    ];
    syncAppServerControlQuickSettingsFromSnapshot(id, 'grok', { configOptions: options });
    setAppServerControlQuickSettingsDraft(id, {
      configOptions: options.map((option) => ({
        ...option,
        currentValue: option.configId === 'agent' ? 'reviewer' : true,
      })),
    });
    syncAppServerControlQuickSettingsFromSnapshot(id, 'grok', { configOptions: options });
    expect(createAppServerControlTurnRequestWithQuickSettings(id, 'Inspect').configValues).toEqual({
      agent: 'reviewer',
      concise: true,
    });
    syncAppServerControlQuickSettingsFromSnapshot(id, 'grok', {
      configOptions: [
        { ...options[0]!, options: [{ value: '', name: 'Default' }] },
        { ...options[1]!, currentValue: true },
      ],
    });
    expect(
      createAppServerControlTurnRequestWithQuickSettings(id, 'Inspect').configValues,
    ).toBeUndefined();
  });

  it('persists Codex fast mode and includes it in the next turn request', () => {
    $sessions.set({
      'codex-default': {
        id: 'codex-default',
        profileHint: 'codex',
      } as never,
    });

    setAppServerControlQuickSettingsDraft('codex-default', { fastMode: 'on' });

    expect(getAppServerControlQuickSettingsDraft('codex-default').fastMode).toBe('on');
    expect(
      createAppServerControlTurnRequestWithQuickSettings(
        'codex-default',
        'Use the fast service tier.',
      ).fastMode,
    ).toBe('on');
  });

  it('preserves ACP agent model ids without provider-specific alias rewriting', () => {
    globalThis.localStorage.setItem(
      'midterm:appServerControl-quick-settings:provider:grok',
      JSON.stringify({ model: 'grok-build' }),
    );
    $sessions.set({
      'grok-stale': {
        id: 'grok-stale',
        profileHint: 'grok',
      } as never,
    });

    expect(getAppServerControlQuickSettingsDraft('grok-stale').model).toBe('grok-build');
  });
});
