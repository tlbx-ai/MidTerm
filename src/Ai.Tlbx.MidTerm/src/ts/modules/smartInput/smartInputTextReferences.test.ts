import { describe, expect, it } from 'vitest';

import {
  buildSmartInputTextReferenceFile,
  getSmartInputTextReferenceStats,
  shouldConvertPastedTextToSmartInputReference,
  SMART_INPUT_TEXT_REFERENCE_MIN_LINES,
} from './smartInputTextReferences';

describe('smartInputTextReferences', () => {
  it('counts lines and chars for a pasted text reference', () => {
    expect(getSmartInputTextReferenceStats('a\nbb\nccc')).toEqual({
      lineCount: 3,
      charCount: 8,
    });
  });

  it('converts only large pasted text blocks into staged references', () => {
    const smallText = Array.from(
      { length: SMART_INPUT_TEXT_REFERENCE_MIN_LINES - 1 },
      () => 'x',
    ).join('\n');
    const largeText = Array.from({ length: SMART_INPUT_TEXT_REFERENCE_MIN_LINES }, () => 'x').join(
      '\n',
    );

    expect(shouldConvertPastedTextToSmartInputReference(smallText)).toBe(false);
    expect(shouldConvertPastedTextToSmartInputReference(largeText)).toBe(true);
  });

  it('creates a plain text file for the staged file viewer upload path', () => {
    const file = buildSmartInputTextReferenceFile('line 1\nline 2');

    expect(file.type).toBe('text/plain');
    expect(file.name).toMatch(/^pasted-text-.*\.txt$/);
  });
});
