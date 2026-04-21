import type { GitCommitDetailsResponse, GitDiffFileView } from './types';

export interface GitCommandSuggestion {
  label: string;
  command: string;
}

export function quoteGitPath(path: string): string {
  return `"${path.replace(/(["\\$`])/g, '\\$1')}"`;
}

export function buildFileCommandSuggestions(
  file: Pick<GitDiffFileView, 'path' | 'status'>,
  scope: 'worktree' | 'staged',
): GitCommandSuggestion[] {
  const quotedPath = quoteGitPath(file.path);
  const suggestions: GitCommandSuggestion[] = [
    { label: 'Status', command: `git status --short -- ${quotedPath}` },
  ];

  if (scope === 'staged') {
    suggestions.push({ label: 'Show staged diff', command: `git diff --cached -- ${quotedPath}` });
    suggestions.push({
      label: 'Unstage file',
      command: `git restore --staged -- ${quotedPath}`,
    });
    return suggestions;
  }

  suggestions.push({ label: 'Show diff', command: `git diff -- ${quotedPath}` });

  if (file.status === 'untracked') {
    suggestions.push({ label: 'Stage file', command: `git add -- ${quotedPath}` });
    suggestions.push({
      label: 'Preview clean',
      command: `git clean --dry-run -- ${quotedPath}`,
    });
    return suggestions;
  }

  suggestions.push({ label: 'Stage file', command: `git add -- ${quotedPath}` });
  suggestions.push({
    label: 'Discard changes',
    command: `git restore --worktree -- ${quotedPath}`,
  });
  return suggestions;
}

export function buildCommitCommandSuggestions(
  commit: Pick<GitCommitDetailsResponse, 'hash'>,
): GitCommandSuggestion[] {
  return [
    { label: 'Show commit', command: `git show ${commit.hash}` },
    { label: 'Diff commit', command: `git diff ${commit.hash}^ ${commit.hash}` },
  ];
}
