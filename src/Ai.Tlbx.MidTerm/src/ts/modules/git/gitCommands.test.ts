import { describe, expect, it } from 'vitest';

import { quoteGitPath } from './gitCommands';

describe('gitCommands', () => {
  it('quotes git paths for terminal handoff', () => {
    expect(quoteGitPath('src/my file.ts', 'Pwsh')).toBe("'src/my file.ts'");
    expect(quoteGitPath('src/"quoted".ts', 'Pwsh')).toBe('\'src/"quoted".ts\'');
    expect(quoteGitPath("src/it's $file`.ts", 'Pwsh')).toBe("'src/it''s $file`.ts'");
    expect(quoteGitPath("src/it's $file`.ts", 'Bash')).toBe("'src/it'\"'\"'s $file`.ts'");
    expect(quoteGitPath('src/smart‘quote’.ts', 'Pwsh')).toBe("'src/smart‘‘quote’’.ts'");
    expect(quoteGitPath('file.ts', 'Unknown')).toBeNull();
  });
});
