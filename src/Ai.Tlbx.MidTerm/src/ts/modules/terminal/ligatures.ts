import type { TerminalState } from '../../types';

const TERMINAL_LIGATURE_SEQUENCES = [
  '<!--',
  '<===',
  '<==>',
  '<==',
  '<=>',
  '<=<',
  '<->',
  '<--',
  '<-=',
  '!==',
  '=/=',
  '===>',
  '===',
  '==>',
  '=>>',
  '=>',
  '>-=',
  '>->',
  '>=',
  '>>=',
  '>>>',
  '-->',
  '---',
  '->',
  '-<<',
  '-<',
  '-|-',
  '-~',
  '.=',
  '..<',
  '...',
  ':::',
  '::',
  ':=',
  ':>',
  ';;',
  '<<=',
  '<<-',
  '<<',
  '<=',
  '<|',
  '<:',
  '<-',
  '<~',
  '!=',
  '==',
  '>=',
  '>>',
  '--',
  '->',
  '++',
  '&&',
  '||',
  '??',
  '/*',
  '*/',
  '//',
] as const;

const TERMINAL_LIGATURE_PATTERN = new RegExp(
  Array.from(new Set(TERMINAL_LIGATURE_SEQUENCES))
    .sort((left, right) => right.length - left.length || left.localeCompare(right))
    .map(escapeRegex)
    .join('|'),
  'g',
);

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.-]/g, '\\$&');
}

export function getTerminalLigatureRanges(text: string): [number, number][] {
  if (text.length < 2) {
    return [];
  }

  const ranges: [number, number][] = [];
  for (const match of text.matchAll(TERMINAL_LIGATURE_PATTERN)) {
    const start = match.index;
    const value = match[0];
    if (typeof start !== 'number' || value.length < 2) {
      continue;
    }

    ranges.push([start, start + value.length]);
  }

  return ranges;
}

export function detachTerminalLigatureState(
  state: Pick<TerminalState, 'terminal' | 'ligatureJoinerId'>,
): void {
  const joinerId = state.ligatureJoinerId;
  if (typeof joinerId !== 'number') {
    state.ligatureJoinerId = null;
    return;
  }

  try {
    state.terminal.deregisterCharacterJoiner(joinerId);
  } catch {
    // The renderer may already be disposed.
  }

  state.ligatureJoinerId = null;
}

export function syncTerminalLigatureState(
  state: Pick<TerminalState, 'terminal' | 'hasWebgl' | 'ligatureJoinerId'>,
  enabled: boolean,
): void {
  if (!enabled || !state.hasWebgl) {
    detachTerminalLigatureState(state);
    return;
  }

  if (typeof state.ligatureJoinerId === 'number') {
    return;
  }

  state.ligatureJoinerId = state.terminal.registerCharacterJoiner(getTerminalLigatureRanges);
}
