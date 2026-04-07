export interface LensModelOption {
  value: string;
  label: string;
}

const CODEX_MODEL_PRESETS = [
  'gpt-5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex',
  'gpt-5.4-codex',
] as const;

const CLAUDE_MODEL_PRESETS = ['sonnet', 'opus', 'claude-sonnet-4-6', 'claude-opus-4-6'] as const;

export function getLensDefaultModelLabel(provider: string | null | undefined): string {
  return provider === 'claude'
    ? 'Default Claude model'
    : provider === 'codex'
      ? 'Default Codex model'
      : 'Default model';
}

export function getLensModelOptions(args: {
  provider: string | null | undefined;
  currentValues?: readonly (string | null | undefined)[];
}): LensModelOption[] {
  const options: LensModelOption[] = [
    {
      value: '',
      label: getLensDefaultModelLabel(args.provider),
    },
  ];

  for (const preset of getProviderModelPresets(args.provider)) {
    options.push({ value: preset, label: preset });
  }

  for (const value of args.currentValues ?? []) {
    const normalized = normalizeOptionValue(value);
    if (!normalized || options.some((option) => option.value === normalized)) {
      continue;
    }

    options.push({ value: normalized, label: normalized });
  }

  return options;
}

function getProviderModelPresets(provider: string | null | undefined): readonly string[] {
  if (provider === 'claude') {
    return CLAUDE_MODEL_PRESETS;
  }

  if (provider === 'codex') {
    return CODEX_MODEL_PRESETS;
  }

  return [];
}

function normalizeOptionValue(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
