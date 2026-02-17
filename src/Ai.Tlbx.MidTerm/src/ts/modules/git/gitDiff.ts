/**
 * Git Diff Renderer
 *
 * Renders unified diff output with color coding.
 */

import { escapeHtml } from '../../utils';

export function renderDiff(diffText: string): string {
  if (!diffText.trim()) return '<div class="git-diff-empty">No changes</div>';

  const lines = diffText.split('\n');
  let html = '<div class="git-diff-view"><pre class="git-diff-content">';

  for (const line of lines) {
    const escaped = escapeHtml(line);
    if (line.startsWith('+++') || line.startsWith('---')) {
      html += `<span class="git-diff-header">${escaped}</span>\n`;
    } else if (line.startsWith('@@')) {
      html += `<span class="git-diff-hunk">${escaped}</span>\n`;
    } else if (line.startsWith('+')) {
      html += `<span class="git-diff-add">${escaped}</span>\n`;
    } else if (line.startsWith('-')) {
      html += `<span class="git-diff-del">${escaped}</span>\n`;
    } else {
      html += `${escaped}\n`;
    }
  }

  html += '</pre></div>';
  return html;
}
