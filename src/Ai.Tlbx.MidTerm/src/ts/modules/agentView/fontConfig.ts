import { $currentSettings } from '../../stores';
import { buildTerminalFontStack, getBundledTerminalFontFamilies } from '../terminal/fontConfig';

export const DEFAULT_AGENT_MESSAGE_FONT_FAMILY = 'default';

const AGENT_MESSAGE_FONT_FAMILY_OPTIONS = [
  DEFAULT_AGENT_MESSAGE_FONT_FAMILY,
  'sans',
  'serif',
  'Segoe UI',
  'Helvetica Neue',
  'Arial',
  'Verdana',
  'Tahoma',
  'Trebuchet MS',
  ...getBundledTerminalFontFamilies(),
];

function quoteFontFamily(fontFamily: string): string {
  return `'${fontFamily.replace(/'/g, "\\'")}'`;
}

export function getAgentMessageFontFamilies(): readonly string[] {
  return AGENT_MESSAGE_FONT_FAMILY_OPTIONS;
}

export function normalizeAgentMessageFontFamily(
  value: string | null | undefined,
  fallback: string = DEFAULT_AGENT_MESSAGE_FONT_FAMILY,
): string {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return fallback;
  }

  const match = AGENT_MESSAGE_FONT_FAMILY_OPTIONS.find(
    (candidate) => candidate.toLowerCase() === trimmed.toLowerCase(),
  );
  return match ?? fallback;
}

export function getConfiguredAgentMessageFontFamily(): string {
  return normalizeAgentMessageFontFamily($currentSettings.get()?.agentMessageFontFamily);
}

export function buildAgentMessageFontStack(
  fontFamily: string = getConfiguredAgentMessageFontFamily(),
): string {
  const normalized = normalizeAgentMessageFontFamily(fontFamily);
  switch (normalized) {
    case 'default':
      return "'Segoe UI Variable Text', 'Segoe UI', var(--font-ui)";
    case 'sans':
      return 'var(--font-ui)';
    case 'serif':
      return "Georgia, 'Times New Roman', serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', 'Segoe UI Symbol'";
    case 'Segoe UI':
    case 'Helvetica Neue':
    case 'Arial':
    case 'Verdana':
    case 'Tahoma':
    case 'Trebuchet MS':
      return `${quoteFontFamily(normalized)}, var(--font-ui)`;
    default:
      return buildTerminalFontStack(normalized);
  }
}
