import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildLineNumberText, formatBinaryDump, highlightCode } from './rendering';

const originalDocument = globalThis.document;

function escapeForTest(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

describe('fileViewer rendering', () => {
  beforeAll(() => {
    Object.assign(globalThis, {
      document: {
        createElement: () => {
          let text = '';
          return {
            set textContent(value: string) {
              text = value ?? '';
            },
            get textContent(): string {
              return text;
            },
            get innerHTML(): string {
              return escapeForTest(text);
            },
          };
        },
      },
    });
  });

  afterAll(() => {
    Object.assign(globalThis, {
      document: originalDocument,
    });
  });

  it('builds aligned line number text with a minimum of one line', () => {
    expect(buildLineNumberText(0)).toBe('1');
    expect(buildLineNumberText(4)).toBe('1\n2\n3\n4');
  });

  it('formats binary bytes as hex and ascii', () => {
    const dump = formatBinaryDump(new Uint8Array([0x41, 0x42, 0x00, 0x7f, 0x20]));

    expect(dump).toMatch(/^00000000  41 42 00 7F 20/);
    expect(dump).toContain('AB.. ');
  });

  it('starts a new row every sixteen bytes', () => {
    const bytes = new Uint8Array(17).map((_, index) => index);
    const lines = formatBinaryDump(bytes).split('\n');

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^00000000/);
    expect(lines[1]).toMatch(/^00000010/);
  });

  it('does not re-highlight generated markup inside comment spans', () => {
    const highlighted = highlightCode(
      '# Wazuh - SIEM/XDR manager + dashboard\n# See: IT Notes/Projects/Wazuh Security/Overview.md',
      '.tf',
    );

    expect(highlighted).toContain('<span class="hl-comment"># Wazuh - SIEM/XDR manager + dashboard</span>');
    expect(highlighted).not.toContain('<span <span');
    expect(highlighted).not.toContain('hl-keyword">class</span>');
  });

  it('keeps literal html snippets escaped as text content', () => {
    const highlighted = highlightCode('<span class="hl-comment"># nope</span>', '.html');

    expect(highlighted).toContain('&lt;span');
    expect(highlighted).toContain('&lt;/span&gt;');
    expect(highlighted).not.toContain('<span class="hl-comment"># nope</span>');
  });
});
