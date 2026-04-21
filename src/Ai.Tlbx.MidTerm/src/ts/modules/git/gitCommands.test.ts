import { describe, expect, it } from 'vitest';

import {
  buildCommitCommandSuggestions,
  buildFileCommandSuggestions,
  quoteGitPath,
} from './gitCommands';

describe('gitCommands', () => {
  it('quotes git paths for terminal handoff', () => {
    expect(quoteGitPath('src/my file.ts')).toBe('"src/my file.ts"');
    expect(quoteGitPath('src/"quoted".ts')).toBe('"src/\\"quoted\\".ts"');
  });

  it('builds staged file command suggestions', () => {
    const suggestions = buildFileCommandSuggestions(
      { path: 'src/app.ts', status: 'modified' },
      'staged',
    );

    expect(suggestions.map((entry) => entry.command)).toEqual([
      'git status --short -- "src/app.ts"',
      'git diff --cached -- "src/app.ts"',
      'git restore --staged -- "src/app.ts"',
    ]);
  });

  it('builds untracked file command suggestions', () => {
    const suggestions = buildFileCommandSuggestions(
      { path: 'notes/todo.md', status: 'untracked' },
      'worktree',
    );

    expect(suggestions.map((entry) => entry.command)).toEqual([
      'git status --short -- "notes/todo.md"',
      'git diff -- "notes/todo.md"',
      'git add -- "notes/todo.md"',
      'git clean --dry-run -- "notes/todo.md"',
    ]);
  });

  it('builds commit command suggestions', () => {
    const suggestions = buildCommitCommandSuggestions({ hash: 'abc123' });

    expect(suggestions.map((entry) => entry.command)).toEqual([
      'git show abc123',
      'git diff abc123^ abc123',
    ]);
  });
});
