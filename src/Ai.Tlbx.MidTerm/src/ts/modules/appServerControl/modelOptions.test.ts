import { describe, expect, it } from 'vitest';
import { getAppServerControlEffortOptions } from './modelOptions';

describe('native model effort capabilities', () => {
  const models = [
    {
      value: 'opus',
      label: 'Opus',
      isDefault: true,
      effortOptions: [{ value: 'high', label: 'High' }],
    },
    { value: 'haiku', label: 'Haiku', effortOptions: [] },
  ];
  it('uses the selected model rather than the previous model effort catalogue', () => {
    expect(
      getAppServerControlEffortOptions({
        model: 'haiku',
        modelOptions: models,
        currentValues: ['high'],
        catalogOptions: [{ value: 'high', label: 'High' }],
      }),
    ).toEqual([{ value: '', label: 'Default' }]);
    expect(
      getAppServerControlEffortOptions({ model: null, modelOptions: models }).map(
        (option) => option.value,
      ),
    ).toEqual(['', 'high']);
  });
  it('retains the session catalogue when no per-model capability was supplied', () => {
    expect(
      getAppServerControlEffortOptions({
        model: 'custom',
        modelOptions: models,
        catalogOptions: [{ value: 'low', label: 'Low' }],
      }).map((option) => option.value),
    ).toEqual(['', 'low']);
  });
});
