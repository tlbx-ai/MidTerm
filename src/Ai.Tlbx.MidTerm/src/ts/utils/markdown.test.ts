import { describe, expect, it } from 'vitest';

import { renderMarkdown, renderMarkdownFragment } from './markdown';

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

  it('renders safe markdown images inline', () => {
    const safe = renderMarkdown('![Preview](/img/logo.png)');
    const unsafe = renderMarkdown('![Oops](javascript:alert(1))');

    expect(safe).toContain('<figure class="agent-markdown-figure">');
    expect(safe).toContain('<img class="agent-markdown-image" src="/img/logo.png"');
    expect(safe).toContain('<figcaption class="agent-markdown-figcaption">Preview</figcaption>');
    expect(unsafe).not.toContain('<img ');
    expect(unsafe).toContain('Oops');
  });

  it('renders markdown tables with column alignment', () => {
    const html = renderMarkdown(
      '| Name | Score | Delta |\n| :--- | ---: | :---: |\n| Alpha | 42 | up |\n| Beta | 7 | flat |',
    );

    expect(html).toContain(
      '<div class="agent-markdown-table-wrap"><table class="agent-markdown-table">',
    );
    expect(html).toContain(
      '<th data-align="left" data-col-kind="text" title="Name" aria-label="Name">Name</th>',
    );
    expect(html).toContain(
      '<th data-align="right" data-col-kind="numeric" title="Score" aria-label="Score">Score</th>',
    );
    expect(html).toContain(
      '<th data-align="center" data-col-kind="text" title="Delta" aria-label="Delta">Delta</th>',
    );
    expect(html).toContain('<td data-align="right" data-col-kind="numeric">42</td>');
    expect(html).toContain(
      '<td data-align="center" data-col-kind="text"><span class="agent-markdown-cell-pill" data-cell-tone="default" data-cell-kind="text">flat</span></td>',
    );
  });

  it('marks dense operator tables with semantic column kinds', () => {
    const html = renderMarkdown(
      '| Lane | Mode | Queue | Scrollback | CPU peak | Model | Notes |\n| :--- | :--- | ---: | ---: | ---: | :--- | :--- |\n| Alpha | Lens | 3 | 4112 | 31% | gpt-5.4-mini | Approval request open and still visible |\n| Beta | Terminal | 0 | 932 | 12% | none | Waiting for input |',
    );

    expect(html).toContain('<table class="agent-markdown-table" data-table-density="dense">');
    expect(html).toContain(
      '<th data-align="left" data-col-kind="key" title="Lane" aria-label="Lane"><span class="agent-markdown-th-short">Lane</span></th>',
    );
    expect(html).toContain(
      '<th data-align="left" data-col-kind="tag" title="Mode" aria-label="Mode"><span class="agent-markdown-th-short">Mode</span></th>',
    );
    expect(html).toContain(
      '<th data-align="right" data-col-kind="numeric" title="Queue" aria-label="Queue"><span class="agent-markdown-th-short">Queue</span></th>',
    );
    expect(html).toContain(
      '<th data-align="right" data-col-kind="numeric" title="Scrollback" aria-label="Scrollback"><span class="agent-markdown-th-short">Scroll</span></th>',
    );
    expect(html).toContain(
      '<th data-align="left" data-col-kind="notes" title="Notes" aria-label="Notes"><span class="agent-markdown-th-short">Notes</span></th>',
    );
    expect(html).toContain(
      '<td data-align="left" data-col-kind="tag"><span class="agent-markdown-cell-pill" data-cell-tone="info" data-cell-kind="tag">Lens</span></td>',
    );
    expect(html).toContain(
      '<td data-align="left" data-col-kind="tag"><span class="agent-markdown-cell-pill" data-cell-tone="info" data-cell-kind="tag">gpt-5.4-mini</span></td>',
    );
    expect(html).toContain(
      '<td data-align="left" data-col-kind="notes">Approval request open and still visible</td>',
    );
  });

  it('does not treat underscores inside plain tokens as emphasis', () => {
    const html = renderMarkdown('HELLO_FROM_CODEX\n\nTOOL_DONE');

    expect(html).toContain('<p>HELLO_FROM_CODEX</p>');
    expect(html).toContain('<p>TOOL_DONE</p>');
    expect(html).not.toContain('<em>');
  });

  it('keeps single line breaks inside one dense paragraph', () => {
    const html = renderMarkdown('First line\nSecond line');

    expect(html).toBe('<p>First line<br>Second line</p>');
  });

  it('keeps blank lines as actual paragraph breaks', () => {
    const html = renderMarkdown('First line\n\nSecond line');

    expect(html).toBe(
      '<p>First line</p>\n<div class="agent-markdown-gap" style="--agent-markdown-gap-lines:1" aria-hidden="true"></div>\n<p>Second line</p>',
    );
  });

  it('scales compact gap markers for repeated blank lines', () => {
    const html = renderMarkdown('First line\n\n\nSecond line');

    expect(html).toBe(
      '<p>First line</p>\n<div class="agent-markdown-gap" style="--agent-markdown-gap-lines:2" aria-hidden="true"></div>\n<p>Second line</p>',
    );
  });

  it('unwraps a single paragraph for dense chat rendering', () => {
    expect(renderMarkdownFragment('HELLO_FROM_CODEX')).toBe('HELLO_FROM_CODEX');
    expect(renderMarkdownFragment('Paragraph with **bold** text.')).toBe(
      'Paragraph with <strong>bold</strong> text.',
    );
    expect(renderMarkdownFragment('First line\nSecond line')).toBe('First line<br>Second line');
    expect(renderMarkdownFragment('- one\n- two')).toContain('<ul>');
  });
});
