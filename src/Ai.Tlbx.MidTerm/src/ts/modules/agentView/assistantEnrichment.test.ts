import { describe, expect, it } from 'vitest';

import { scanAssistantTextEnrichment } from './assistantEnrichment';

describe('scanAssistantTextEnrichment', () => {
  it('finds bare urls, file paths, git hashes, and numeric text', () => {
    const result = scanAssistantTextEnrichment(
      'Visit https://openai.com, inspect Q:\\repo\\src\\app.ts:42, commit abc1234, queue 17.',
    );

    expect(result.tokens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'url',
          text: 'https://openai.com',
          href: 'https://openai.com',
        }),
        expect.objectContaining({
          kind: 'file',
          text: 'Q:\\repo\\src\\app.ts:42',
          filePath: 'Q:\\repo\\src\\app.ts',
          line: 42,
          filePathKind: 'absolute',
        }),
        expect.objectContaining({
          kind: 'git',
          text: 'abc1234',
          hash: 'abc1234',
        }),
        expect.objectContaining({
          kind: 'number',
          text: '17',
        }),
      ]),
    );
  });

  it('collects image preview candidates from assistant file references', () => {
    const result = scanAssistantTextEnrichment(
      'See assets/screenshot.png and C:\\captures\\panel.webp for the issue.',
    );

    expect(result.imageCandidates).toHaveLength(2);
    expect(result.imageCandidates).toEqual(
      expect.arrayContaining([
        {
          displayText: 'assets/screenshot.png',
          normalizedPath: 'assets/screenshot.png',
          pathKind: 'relative',
          line: null,
          column: null,
        },
        {
          displayText: 'C:\\captures\\panel.webp',
          normalizedPath: 'C:\\captures\\panel.webp',
          pathKind: 'absolute',
          line: null,
          column: null,
        },
      ]),
    );
  });

  it('mutes plain-text table outlines without touching the content words', () => {
    const result = scanAssistantTextEnrichment('| Name | Value |\n| ---- | ----- |');

    expect(result.tokens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'table_rule', text: '|' }),
        expect.objectContaining({ kind: 'table_rule', text: '-' }),
      ]),
    );
    expect(result.tokens.some((token) => token.text === 'Name')).toBe(false);
  });

  it('avoids false positives for url-like and dotted non-path tokens', () => {
    const result = scanAssistantTextEnrichment(
      'Keep Results.Forbid and https://midterm.dev/docs distinct from 1.2.3.',
    );

    expect(result.tokens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'url',
          text: 'https://midterm.dev/docs',
        }),
        expect.objectContaining({
          kind: 'number',
          text: '1.2.3',
        }),
      ]),
    );
    expect(
      result.tokens.some((token) => token.kind === 'file' && token.text.includes('Results.Forbid')),
    ).toBe(false);
  });

  it('uses provided file mentions and preserves resolved metadata', () => {
    const result = scanAssistantTextEnrichment('Open src/app.ts and assets/panel.png', [
      {
        field: 'body',
        displayText: 'src/app.ts',
        path: 'src/app.ts',
        pathKind: 'relative',
        resolvedPath: 'Q:\\repo\\src\\app.ts',
        exists: true,
        isDirectory: false,
        mimeType: 'text/plain',
      },
      {
        field: 'body',
        displayText: 'assets/panel.png',
        path: 'assets/panel.png',
        pathKind: 'relative',
        resolvedPath: 'Q:\\repo\\assets\\panel.png',
        exists: true,
        isDirectory: false,
        mimeType: 'image/png',
      },
    ]);

    expect(result.tokens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'file',
          text: 'src/app.ts',
          filePath: 'src/app.ts',
          resolvedPath: 'Q:\\repo\\src\\app.ts',
          mimeType: 'text/plain',
        }),
        expect.objectContaining({
          kind: 'file',
          text: 'assets/panel.png',
          filePath: 'assets/panel.png',
          resolvedPath: 'Q:\\repo\\assets\\panel.png',
          mimeType: 'image/png',
        }),
      ]),
    );
  });
});
