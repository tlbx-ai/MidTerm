import type { GitCommitDetailsResponse, GitDiffFileView } from './types';

export interface GitCommandSuggestion {
  label: string;
  command: string;
}

export function quoteGitPath(path: string, shell: string): string | null {
  if (shell === 'Pwsh' || shell === 'PowerShell') return `'${path.replace(/['‘’]/g, '$&$&')}'`;
  if (shell === 'Bash' || shell === 'Zsh') return `'${path.replace(/'/g, "'\"'\"'")}'`;
  return null;
}

export function buildFileCommandSuggestions(
  file: Pick<GitDiffFileView, 'path' | 'status'>,
  scope: 'worktree' | 'staged',
  repoRoot: string,
  shell: string,
): GitCommandSuggestion[] {
  const quotedPath = quoteGitPath(file.path, shell);
  const quotedRoot = quoteGitPath(repoRoot, shell);
  if (quotedPath === null || quotedRoot === null || !repoRoot) return [];
  const git = `git -C ${quotedRoot} --literal-pathspecs`;
  const suggestions: GitCommandSuggestion[] = [
    { label: 'Status', command: `${git} status --short -- ${quotedPath}` },
  ];

  if (scope === 'staged') {
    suggestions.push({
      label: 'Show staged diff',
      command: `${git} diff --cached -- ${quotedPath}`,
    });
    suggestions.push({
      label: 'Unstage file',
      command: `${git} restore --staged -- ${quotedPath}`,
    });
    return suggestions;
  }

  suggestions.push({
    label: 'Show diff',
    command:
      file.status === 'untracked'
        ? `${git} diff --no-index -- /dev/null ${quotedPath}`
        : `${git} diff -- ${quotedPath}`,
  });

  if (file.status === 'untracked') {
    suggestions.push({ label: 'Stage file', command: `${git} add -- ${quotedPath}` });
    suggestions.push({
      label: 'Preview clean',
      command: `${git} clean --dry-run -- ${quotedPath}`,
    });
    return suggestions;
  }

  suggestions.push({ label: 'Stage file', command: `${git} add -- ${quotedPath}` });
  suggestions.push({
    label: 'Discard changes',
    command: `${git} restore --worktree -- ${quotedPath}`,
  });
  return suggestions;
}

export function buildCommitCommandSuggestions(
  commit: Pick<
    GitCommitDetailsResponse,
    'hash' | 'parentHashes' | 'comparedParentHash' | 'comparedParentIndex'
  >,
  repoRoot: string,
  shell: string,
): GitCommandSuggestion[] {
  const quotedRoot = quoteGitPath(repoRoot, shell);
  if (quotedRoot === null || !repoRoot || !/^[0-9a-f]{7,64}$/i.test(commit.hash)) return [];
  const git = `git -C ${quotedRoot}`;
  const parent = commit.comparedParentHash ?? commit.parentHashes[commit.comparedParentIndex ?? 0];
  if (parent && !/^[0-9a-f]{7,64}$/i.test(parent)) return [];
  const comparison = parent
    ? `${git} diff ${parent} ${commit.hash}`
    : `${git} diff-tree --root -r --no-commit-id -p ${commit.hash}`;
  return [
    { label: 'Show commit', command: `${git} show ${commit.hash}` },
    { label: 'Diff commit', command: comparison },
  ];
}
