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

function formatMarkdownLinks(escapedText: string): string {
  return escapedText.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, text: string, url: string) => {
    const trimmedUrl = url.trim();
    if (!isSafeMarkdownHref(trimmedUrl)) {
      return text;
    }

    return `<a href="${trimmedUrl}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  });
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

  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  html = html.replace(/_([^_\n]+)_/g, '<em>$1</em>');

  html = formatMarkdownLinks(html);
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
  html = html.replace(/^---$/gm, '<hr>');
  html = html.replace(/^\*\*\*$/gm, '<hr>');

  html = html.replace(/^- (.+)$/gm, '<li data-list="ul">$1</li>');
  html = html.replace(/^\d+\. (.+)$/gm, '<li data-list="ol">$1</li>');
  html = html.replace(/((?:<li data-list="ul">.*?<\/li>\n?)+)/g, (match) => {
    return `<ul>${match.replace(/\n/g, '').replace(/ data-list="ul"/g, '')}</ul>`;
  });
  html = html.replace(/((?:<li data-list="ol">.*?<\/li>\n?)+)/g, (match) => {
    return `<ol>${match.replace(/\n/g, '').replace(/ data-list="ol"/g, '')}</ol>`;
  });

  html = html.replace(/^(?!<(?:h\d|ul|ol|li|pre|blockquote|hr))(?!\s*$)(.+)$/gm, '<p>$1</p>');
  html = html.replace(/<p><\/p>/g, '');

  for (let index = 0; index < codeBlocks.length; index += 1) {
    const codeBlock = codeBlocks[index];
    if (!codeBlock) {
      continue;
    }

    html = html.replace(`@@MIDTERMMD${index}@@`, codeBlock);
  }

  return html;
}
