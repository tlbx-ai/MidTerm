function escapeMarkdownHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isSafeMarkdownHref(url: string): boolean {
  return /^(https?:\/\/|mailto:)/i.test(url);
}

function isSafeMarkdownImageSrc(url: string): boolean {
  return /^(https?:\/\/|\/)/i.test(url);
}

function formatMarkdownImages(escapedText: string): string {
  return escapedText.replace(
    /!\[([^\]]*)\]\(([^)]+)\)/g,
    (_match, altText: string, url: string) => {
      const trimmedUrl = url.trim();
      if (!isSafeMarkdownImageSrc(trimmedUrl)) {
        return altText || '';
      }

      const caption = altText.trim();
      return `<figure class="agent-markdown-figure"><img class="agent-markdown-image" src="${trimmedUrl}" alt="${caption}" loading="lazy"${caption ? '' : ' aria-hidden="true"'}>${caption ? `<figcaption class="agent-markdown-figcaption">${caption}</figcaption>` : ''}</figure>`;
    },
  );
}

function formatMarkdownLinks(escapedText: string): string {
  return escapedText.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, text: string, url: string) => {
    const trimmedUrl = url.trim();
    if (!isSafeMarkdownHref(trimmedUrl)) {
      return text;
    }

    return `<a href="${trimmedUrl}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  });
}

function replaceStrong(text: string, delimiter: '\\*\\*' | '__'): string {
  return text.replace(
    new RegExp(`(^|[^\\w])${delimiter}([^\\n]+?)${delimiter}(?=$|[^\\w])`, 'gm'),
    (_match, prefix: string, content: string) => `${prefix}<strong>${content.trim()}</strong>`,
  );
}

function replaceEmphasis(text: string, delimiter: '\\*' | '_'): string {
  return text.replace(
    new RegExp(`(^|[^\\w])${delimiter}([^\\n]+?)${delimiter}(?=$|[^\\w])`, 'gm'),
    (_match, prefix: string, content: string) => `${prefix}<em>${content.trim()}</em>`,
  );
}

function isMarkdownTableSeparator(line: string): boolean {
  return /^\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?$/.test(line.trim());
}

function isMarkdownTableRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) {
    return false;
  }

  const cells = splitMarkdownTableRow(trimmed);
  return cells.length >= 2;
}

function splitMarkdownTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function parseMarkdownTableAlignments(line: string): Array<'left' | 'center' | 'right' | ''> {
  return splitMarkdownTableRow(line).map((cell) => {
    const trimmed = cell.trim();
    const left = trimmed.startsWith(':');
    const right = trimmed.endsWith(':');
    if (left && right) {
      return 'center';
    }
    if (right) {
      return 'right';
    }
    if (left) {
      return 'left';
    }
    return '';
  });
}

type MarkdownTableColumnKind = 'key' | 'tag' | 'numeric' | 'notes' | 'text';
type MarkdownTableCellTone = 'default' | 'positive' | 'warning' | 'attention' | 'info' | 'muted';

function normalizeMarkdownTableHeader(cell: string): string {
  return cell.trim().toLowerCase().replace(/\s+/g, ' ');
}

function looksNumericMarkdownTableCell(cell: string): boolean {
  const trimmed = cell.trim();
  if (!trimmed) {
    return true;
  }

  return /^[<>~]?[+-]?\d[\d.,]*(?:\s?(?:ms|s|%|x|kb|mb|gb|tb|bps|ops|q|px))?$/i.test(trimmed);
}

function inferMarkdownTableColumnKinds(
  headers: readonly string[],
  rows: readonly string[][],
  alignments: ReadonlyArray<'left' | 'center' | 'right' | ''>,
): MarkdownTableColumnKind[] {
  return headers.map((header, index) => {
    const normalizedHeader = normalizeMarkdownTableHeader(header);
    const cells = rows.map((row) => row[index] ?? '').filter((cell) => cell.trim().length > 0);
    const numericLike = cells.length > 0 && cells.every(looksNumericMarkdownTableCell);

    if (
      /^(notes?|details?|summary|reason|risk|benefit|description|output|message|comment)s?$/.test(
        normalizedHeader,
      )
    ) {
      return 'notes';
    }

    if (
      alignments[index] === 'right' ||
      numericLike ||
      /(?:p\d+|tokens?|scrollback|queue|cpu|paint|attach|target|regressed|score|count|size|latency|burst)/.test(
        normalizedHeader,
      )
    ) {
      return 'numeric';
    }

    if (
      /^(lane|metric|surface|render mode|step|item|session|worker|thread)$/.test(normalizedHeader)
    ) {
      return 'key';
    }

    if (/^(mode|state|owner|status|provider|kind|profile|model)$/.test(normalizedHeader)) {
      return 'tag';
    }

    return 'text';
  });
}

function shortMarkdownTableHeaderLabel(header: string, kind: MarkdownTableColumnKind): string {
  const normalizedHeader = normalizeMarkdownTableHeader(header);
  const explicit = new Map<string, string>([
    ['last token burst', 'Burst'],
    ['scrollback', 'Scroll'],
    ['cpu peak', 'CPU'],
    ['first paint', 'Paint'],
    ['attach p95', 'Attach'],
    ['last good build', 'Baseline'],
    ['regressed by', 'Delta'],
    ['render mode', 'Mode'],
  ]);

  const mapped = explicit.get(normalizedHeader);
  if (mapped) {
    return mapped;
  }

  if (kind === 'notes') {
    return 'Notes';
  }

  if (kind === 'numeric' && normalizedHeader.length > 10) {
    return header
      .split(/\s+/)
      .map((part) => part[0] ?? '')
      .join('')
      .toUpperCase();
  }

  const compact = header.trim();
  return compact.length <= 10 ? compact : (compact.split(/\s+/)[0] ?? compact);
}

function renderMarkdownTableHeaderContent(
  header: string,
  kind: MarkdownTableColumnKind,
  dense: boolean,
): string {
  if (!dense) {
    return header;
  }

  const shortLabel = shortMarkdownTableHeaderLabel(header, kind);
  return `<span class="agent-markdown-th-short">${shortLabel}</span>`;
}

function inferMarkdownTableCellTone(
  kind: MarkdownTableColumnKind,
  header: string,
  value: string,
): MarkdownTableCellTone {
  const normalizedHeader = normalizeMarkdownTableHeader(header);
  const normalizedValue = value.trim().toLowerCase();

  if (!normalizedValue) {
    return 'muted';
  }

  if (
    /(blocked|failed|error|degraded|unavailable|stalled|down|denied|timeout|timed out)/.test(
      normalizedValue,
    )
  ) {
    return 'attention';
  }

  if (/(good|ok|healthy|ready|completed|active|streaming|live|restored)/.test(normalizedValue)) {
    return 'positive';
  }

  if (/(replaying|pending|queued|starting|running|attaching|reconnecting)/.test(normalizedValue)) {
    return 'warning';
  }

  if (/(idle|none|human|terminal|shell|unknown|n\/a)/.test(normalizedValue)) {
    return 'muted';
  }

  if (
    kind === 'tag' ||
    /^(mode|state|owner|status|provider|kind|profile|model)$/.test(normalizedHeader) ||
    /(?:lens|codex|claude|gpt|opus|mini|terminal|pwsh|bash)/.test(normalizedValue)
  ) {
    return 'info';
  }

  return 'default';
}

function shouldRenderMarkdownTableCellAsPill(
  kind: MarkdownTableColumnKind,
  header: string,
  value: string,
): boolean {
  const normalizedHeader = normalizeMarkdownTableHeader(header);
  const normalizedValue = value.trim();
  if (!normalizedValue) {
    return false;
  }

  return (
    kind === 'tag' ||
    /^(owner|status|state|mode|provider|profile|model)$/.test(normalizedHeader) ||
    normalizedValue.length <= 18
  );
}

function renderMarkdownTableCellContent(
  header: string,
  value: string,
  kind: MarkdownTableColumnKind,
): string {
  if (kind === 'notes' || kind === 'numeric') {
    return value;
  }

  if (!shouldRenderMarkdownTableCellAsPill(kind, header, value)) {
    return value;
  }

  const tone = inferMarkdownTableCellTone(kind, header, value);
  return `<span class="agent-markdown-cell-pill" data-cell-tone="${tone}" data-cell-kind="${kind}">${value}</span>`;
}

function renderMarkdownTables(text: string): string {
  const lines = text.split('\n');
  const rendered: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const separator = lines[index + 1] ?? '';
    if (!isMarkdownTableRow(line) || !isMarkdownTableSeparator(separator)) {
      rendered.push(line);
      continue;
    }

    const headerCells = splitMarkdownTableRow(line);
    const alignments = parseMarkdownTableAlignments(separator);
    const bodyRows: string[][] = [];
    index += 2;

    while (index < lines.length && isMarkdownTableRow(lines[index] ?? '')) {
      bodyRows.push(splitMarkdownTableRow(lines[index] ?? ''));
      index += 1;
    }
    index -= 1;

    const columnCount = Math.max(
      headerCells.length,
      ...bodyRows.map((row) => row.length),
      alignments.length,
    );
    const normalizedHeaders = Array.from({ length: columnCount }, (_, cellIndex) => {
      return headerCells[cellIndex] ?? '';
    });
    const normalizedRows = bodyRows.map((row) =>
      Array.from({ length: columnCount }, (_, cellIndex) => row[cellIndex] ?? ''),
    );
    const columnKinds = inferMarkdownTableColumnKinds(
      normalizedHeaders,
      normalizedRows,
      alignments,
    );
    const isDense = columnCount >= 7;
    const denseAttr = isDense ? ' data-table-density="dense"' : '';

    rendered.push(
      `<div class="agent-markdown-table-wrap"><table class="agent-markdown-table"${denseAttr}><thead><tr>${normalizedHeaders
        .map((cell, cellIndex) => {
          const alignment = alignments[cellIndex] || '';
          const alignAttr = alignment ? ` data-align="${alignment}"` : '';
          const kindAttr = ` data-col-kind="${columnKinds[cellIndex] ?? 'text'}"`;
          return `<th${alignAttr}${kindAttr} title="${cell}" aria-label="${cell}">${renderMarkdownTableHeaderContent(
            cell,
            columnKinds[cellIndex] ?? 'text',
            isDense,
          )}</th>`;
        })
        .join('')}</tr></thead><tbody>${normalizedRows
        .map(
          (row) =>
            `<tr>${row
              .map((cell, cellIndex) => {
                const alignment = alignments[cellIndex] || '';
                const alignAttr = alignment ? ` data-align="${alignment}"` : '';
                const kind = columnKinds[cellIndex] ?? 'text';
                const kindAttr = ` data-col-kind="${kind}"`;
                return `<td${alignAttr}${kindAttr}>${renderMarkdownTableCellContent(
                  normalizedHeaders[cellIndex] ?? '',
                  cell,
                  kind,
                )}</td>`;
              })
              .join('')}</tr>`,
        )
        .join('')}</tbody></table></div>`,
    );
  }

  return rendered.join('\n');
}

function isBlockLevelMarkdownLine(line: string): boolean {
  return /^<(?:h\d|ul|ol|li|pre|blockquote|hr|table|thead|tbody|tr|th|td|figure|img|figcaption|div)\b/.test(
    line,
  );
}

function wrapMarkdownParagraphs(text: string): string {
  const lines = text.split('\n');
  const rendered: string[] = [];
  const paragraphLines: string[] = [];

  const flushParagraph = () => {
    if (paragraphLines.length === 0) {
      return;
    }

    rendered.push(`<p>${paragraphLines.join('<br>')}</p>`);
    paragraphLines.length = 0;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      continue;
    }

    if (isBlockLevelMarkdownLine(line)) {
      flushParagraph();
      rendered.push(line);
      continue;
    }

    paragraphLines.push(line);
  }

  flushParagraph();
  return rendered.join('\n');
}

export function renderMarkdown(text: string): string {
  const codeBlocks: string[] = [];
  const normalized = text.replace(/\r\n?/g, '\n');
  let html = escapeMarkdownHtml(normalized);

  html = html.replace(
    /```([\w+-]*)\n([\s\S]*?)```/g,
    (_match: string, language: string, code: string) => {
      const languageAttr = language ? ` data-language="${language}"` : '';
      const token = `@@MIDTERMMD${codeBlocks.length}@@`;
      codeBlocks.push(
        `<pre class="agent-markdown-pre"><code${languageAttr}>${code.trim()}</code></pre>`,
      );
      return token;
    },
  );

  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  html = replaceStrong(html, '\\*\\*');
  html = replaceStrong(html, '__');
  html = replaceEmphasis(html, '\\*');
  html = replaceEmphasis(html, '_');

  html = formatMarkdownImages(html);
  html = formatMarkdownLinks(html);
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
  html = html.replace(/^---$/gm, '<hr>');
  html = html.replace(/^\*\*\*$/gm, '<hr>');
  html = renderMarkdownTables(html);

  html = html.replace(/^- (.+)$/gm, '<li data-list="ul">$1</li>');
  html = html.replace(/^\d+\. (.+)$/gm, '<li data-list="ol">$1</li>');
  html = html.replace(/((?:<li data-list="ul">.*?<\/li>\n?)+)/g, (match) => {
    return `<ul>${match.replace(/\n/g, '').replace(/ data-list="ul"/g, '')}</ul>`;
  });
  html = html.replace(/((?:<li data-list="ol">.*?<\/li>\n?)+)/g, (match) => {
    return `<ol>${match.replace(/\n/g, '').replace(/ data-list="ol"/g, '')}</ol>`;
  });

  html = wrapMarkdownParagraphs(html);

  for (let index = 0; index < codeBlocks.length; index += 1) {
    const codeBlock = codeBlocks[index];
    if (!codeBlock) {
      continue;
    }

    html = html.replace(`@@MIDTERMMD${index}@@`, codeBlock);
  }

  return html;
}

export function renderMarkdownFragment(text: string): string {
  const html = renderMarkdown(text).trim();
  const singleParagraph = html.match(/^<p>([\s\S]*)<\/p>$/);
  if (singleParagraph) {
    return singleParagraph[1] ?? '';
  }

  return html;
}
