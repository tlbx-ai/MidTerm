export interface AppServerControlModelOption {
  value: string;
  label: string;
  description?: string | null;
}

const CODEX_MODEL_PRESETS = [
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex',
  'gpt-5.3-codex-spark',
  'gpt-5.2',
  'gpt-5',
  'gpt-5.4-codex',
] as const;

const CLAUDE_MODEL_PRESETS = ['sonnet', 'opus', 'claude-sonnet-4-6', 'claude-opus-4-6'] as const;

export function getAppServerControlDefaultModelLabel(provider: string | null | undefined): string {
  return provider === 'claude'
    ? 'Default Claude model'
    : provider === 'codex'
      ? 'Default Codex model'
      : 'Default model';
}

export function getAppServerControlModelOptions(args: {
  provider: string | null | undefined;
  currentValues?: readonly (string | null | undefined)[];
  defaultLabel?: string | null | undefined;
  catalogOptions?: readonly AppServerControlModelOption[] | null | undefined;
}): AppServerControlModelOption[] {
  const normalizedDefaultLabel = normalizeOptionValue(args.defaultLabel);
  const options: AppServerControlModelOption[] = [
    {
      value: '',
      label: normalizedDefaultLabel ?? getAppServerControlDefaultModelLabel(args.provider),
    },
  ];

  const catalogOptions = normalizeCatalogOptions(args.catalogOptions);
  if (catalogOptions.length > 0) {
    options.push(...catalogOptions);
  } else {
    for (const preset of getProviderModelPresets(args.provider)) {
      options.push({ value: preset, label: preset });
    }
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

export function getAppServerControlEffortOptions(args: {
  currentValues?: readonly (string | null | undefined)[];
  catalogOptions?: readonly AppServerControlModelOption[] | null | undefined;
}): AppServerControlModelOption[] {
  const options: AppServerControlModelOption[] = [{ value: '', label: 'Default' }];
  const catalogOptions = normalizeCatalogOptions(args.catalogOptions);
  if (catalogOptions.length > 0) {
    options.push(...catalogOptions);
  } else {
    for (const preset of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']) {
      options.push({ value: preset, label: humanizeEffort(preset) });
    }
  }

  for (const value of args.currentValues ?? []) {
    const normalized = normalizeOptionValue(value);
    if (!normalized || options.some((option) => option.value === normalized)) {
      continue;
    }

    options.push({ value: normalized, label: humanizeEffort(normalized) });
  }

  return options;
}

function normalizeCatalogOptions(
  catalogOptions: readonly AppServerControlModelOption[] | null | undefined,
): AppServerControlModelOption[] {
  if (!catalogOptions) {
    return [];
  }

  const seen = new Set<string>();
  const options: AppServerControlModelOption[] = [];
  for (const option of catalogOptions) {
    const value = normalizeOptionValue(option.value);
    if (!value || seen.has(value)) {
      continue;
    }

    seen.add(value);
    options.push({
      value,
      label: normalizeOptionValue(option.label) ?? value,
      description: normalizeOptionValue(option.description),
    });
  }

  return options;
}

function humanizeEffort(value: string): string {
  switch (value.trim().toLowerCase()) {
    case 'none':
      return 'None';
    case 'minimal':
      return 'Minimal';
    case 'low':
      return 'Low';
    case 'medium':
      return 'Medium';
    case 'high':
      return 'High';
    case 'xhigh':
      return 'Extra high';
    default:
      return value;
  }
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
