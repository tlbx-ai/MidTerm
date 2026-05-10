import { describe, expect, it } from 'vitest';

import {
  getAppServerControlDefaultModelLabel,
  getAppServerControlEffortOptions,
  getAppServerControlModelOptions,
} from './modelOptions';

describe('appServerControl model options', () => {
  it('returns provider-scoped presets with a default option first', () => {
    expect(getAppServerControlDefaultModelLabel('codex')).toBe('Default Codex model');
    expect(
      getAppServerControlModelOptions({ provider: 'codex' }).map((option) => option.value),
    ).toEqual([
      '',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.3-codex',
      'gpt-5.3-codex-spark',
      'gpt-5.2',
      'gpt-5',
      'gpt-5.4-codex',
    ]);
  });

  it('renders the resolved concrete default model label when one is known', () => {
    expect(
      getAppServerControlModelOptions({
        provider: 'codex',
        defaultLabel: 'gpt-5.4',
      })[0],
    ).toEqual({
      value: '',
      label: 'gpt-5.4',
    });
  });

  it('uses a live catalog before the static Codex fallback', () => {
    expect(
      getAppServerControlModelOptions({
        provider: 'codex',
        catalogOptions: [
          { value: ' gpt-live ', label: 'GPT Live' },
          { value: 'gpt-live', label: 'duplicate' },
        ],
      }),
    ).toEqual([
      { value: '', label: 'Default Codex model' },
      { value: 'gpt-live', label: 'GPT Live', description: null },
    ]);
  });

  it('uses live reasoning effort labels when Codex exposes them', () => {
    expect(
      getAppServerControlEffortOptions({
        catalogOptions: [{ value: 'xhigh', label: 'Extra high' }],
      }),
    ).toEqual([
      { value: '', label: 'Default' },
      { value: 'xhigh', label: 'Extra high', description: null },
    ]);
  });

  it('preserves active custom models that are not in the preset list', () => {
    expect(
      getAppServerControlModelOptions({
        provider: 'claude',
        currentValues: [' claude-custom-experimental ', 'claude-opus-4-6'],
      }).map((option) => option.value),
    ).toEqual([
      '',
      'sonnet',
      'opus',
      'claude-sonnet-4-6',
      'claude-opus-4-6',
      'claude-custom-experimental',
    ]);
  });
});
