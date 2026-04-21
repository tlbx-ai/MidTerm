import { describe, expect, it } from 'vitest';

import { getTerminalLigatureRanges } from './ligatures';

describe('terminal ligatures', () => {
  it('joins common arrow and comparison sequences', () => {
    expect(getTerminalLigatureRanges('a --> b <= c != d => e')).toEqual([
      [2, 5],
      [8, 10],
      [13, 15],
      [18, 20],
    ]);
  });

  it('prefers the longest available ligature sequences', () => {
    expect(getTerminalLigatureRanges('<!-- ===> <=>')).toEqual([
      [0, 4],
      [5, 9],
      [10, 13],
    ]);
  });

  it('ignores plain text without ligature operators', () => {
    expect(getTerminalLigatureRanges('hello world')).toEqual([]);
  });
});
