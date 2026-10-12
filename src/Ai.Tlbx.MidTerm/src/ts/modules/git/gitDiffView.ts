import type { GitDiffFileView, GitDiffLine } from './types';
import { escapeHtml } from '../../utils';
import { t } from '../i18n';

function renderNewFileMetadata(file: GitDiffFileView): string {
  if (!file.isNewFile) return '';
  const size = file.sizeBytes == null ? '' : `${new Intl.NumberFormat().format(file.sizeBytes)} B`;
  return `<div class="git-new-file-metadata">
    <p>${t('git.newFileHint')}</p>
    <p>${escapeHtml([size, file.mimeType, file.encoding].filter(Boolean).join(' · '))}</p>
    ${file.mimeType === 'inode/symlink' ? '' : `<button class="git-action-button" data-action="open-file-viewer" data-path="${escapeHtml(file.path)}" type="button">${t('git.openFilePreview')}</button>`}
  </div>`;
}

export function renderPatchFile(file: GitDiffFileView): string {
  const title = escapeHtml(file.path);
  const subtitle = file.originalPath
    ? `<div class="git-inspector-subtitle">from ${escapeHtml(file.originalPath)}</div>`
    : '';

  const body = file.isBinary
    ? `<div class="git-patch-empty">${file.isNewFile ? t('git.newFileBinary') : 'Binary file changed.'}</div>`
    : file.hunks.length === 0
      ? `<div class="git-patch-empty">${file.isNewFile ? t('git.newFileEmpty') : 'No patch text available.'}</div>`
      : file.hunks
          .map((hunk) => {
            const lines = hunk.lines.map(renderDiffLine).join('\n');
            const lastLine = hunk.lines.reduce(
              (maximum, line) => Math.max(maximum, line.oldLine ?? 0, line.newLine ?? 0),
              0,
            );
            const gutterWidth = Math.max(3, String(lastLine).length + 1);
            return `<section class="git-diff-hunk-block" style="--git-diff-number-width:${gutterWidth}ch">
          <div class="git-diff-hunk-header">${escapeHtml(hunk.header)}</div>
          <pre class="git-diff-lines" tabindex="0" role="region" aria-label="${escapeHtml(`${t('git.diffHunk')}: ${file.path} ${hunk.header}`)}"><code class="git-diff-table">${lines}</code></pre>
        </section>`;
          })
          .join('');

  const truncatedHtml = file.isTruncated
    ? `<div class="git-panel-hint">${file.isNewFile ? t('git.newFileTruncated') : 'Patch output was truncated.'}</div>`
    : '';

  return `<section class="git-inspector-patch">
    <div class="git-inspector-file-header">
      <div>
        <div class="git-inspector-file-title">${title}</div>
        ${subtitle}
      </div>
      ${file.hasLineStats === false || file.isBinary ? '' : `<div class="git-file-loc"><span class="git-loc-add">+${file.additions}</span> <span class="git-loc-del">-${file.deletions}</span></div>`}
    </div>
    ${renderNewFileMetadata(file)}
    ${body}
    ${truncatedHtml}
  </section>`;
}

function renderDiffLine(line: GitDiffLine): string {
  const changeLine = ['add', 'del', 'context'].includes(line.kind);
  const code = line.segments?.length
    ? line.segments
        .map(
          (segment) =>
            `<span${segment.changed ? ' class="git-diff-word-change"' : ''}>${escapeHtml(segment.text)}</span>`,
        )
        .join('')
    : escapeHtml(changeLine ? line.text.slice(1) : line.text);
  const content = changeLine
    ? `<span class="git-diff-number git-diff-number-old" aria-hidden="true">${line.oldLine ?? ''}</span><span class="git-diff-number git-diff-number-new" aria-hidden="true">${line.newLine ?? ''}</span><span class="git-diff-sign">${escapeHtml(line.text.slice(0, 1))}</span><span class="git-diff-code">${code}</span>`
    : `<span class="git-diff-code">${code}</span>`;
  return `<span class="git-diff-line git-diff-line-${escapeHtml(line.kind)}">${content}</span>`;
}
