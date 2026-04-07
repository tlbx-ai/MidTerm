import { describe, expect, it } from 'vitest';

import { getLensDefaultModelLabel, getLensModelOptions } from './modelOptions';

describe('lens model options', () => {
  it('returns provider-scoped presets with a default option first', () => {
    expect(getLensDefaultModelLabel('codex')).toBe('Default Codex model');
    expect(getLensModelOptions({ provider: 'codex' }).map((option) => option.value)).toEqual([
      '',
      'gpt-5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.3-codex',
      'gpt-5.4-codex',
    ]);
  });

  it('preserves active custom models that are not in the preset list', () => {
    expect(
      getLensModelOptions({
        provider: 'claude',
        currentValues: [' claude-custom-experimental ', 'claude-opus-4-6'],
      }).map((option) => option.value),
    ).toEqual(['', 'sonnet', 'opus', 'claude-sonnet-4-6', 'claude-opus-4-6', 'claude-custom-experimental']);
  });
});
