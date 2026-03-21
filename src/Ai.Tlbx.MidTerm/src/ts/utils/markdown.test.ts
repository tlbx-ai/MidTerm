import { describe, expect, it } from 'vitest';

import { renderMarkdown } from './markdown';

describe('renderMarkdown', () => {
  it('renders common assistant markdown constructs', () => {
    const html = renderMarkdown(
      '# Title\n\nParagraph with **bold** text and `code`.\n\n- one\n- two\n\n```ts\nconst value = 1;\n```',
    );

    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<ul><li>one</li><li>two</li></ul>');
    expect(html).toContain(
      '<pre class="agent-markdown-pre"><code data-language="ts">const value = 1;</code></pre>',
    );
  });

  it('only renders safe markdown links as anchors', () => {
    const safe = renderMarkdown('[OpenAI](https://openai.com)');
    const unsafe = renderMarkdown('[Oops](javascript:alert(1))');

    expect(safe).toContain('<a href="https://openai.com"');
    expect(unsafe).not.toContain('<a href=');
    expect(unsafe).toContain('Oops');
  });

  it('does not treat underscores inside plain tokens as emphasis', () => {
    const html = renderMarkdown('HELLO_FROM_CODEX\n\nTOOL_DONE');

    expect(html).toContain('<p>HELLO_FROM_CODEX</p>');
    expect(html).toContain('<p>TOOL_DONE</p>');
    expect(html).not.toContain('<em>');
  });
});
