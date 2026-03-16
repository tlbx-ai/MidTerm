import { describe, expect, it } from 'vitest';

import { getAgentGuidanceFile, getInjectGuidancePromptKey } from './midtermGuidance';

describe('midtermGuidance', () => {
  it('defaults to AGENTS guidance for non-claude processes', () => {
    expect(getAgentGuidanceFile('codex')).toBe('.midterm/AGENTS.md');
    expect(getInjectGuidancePromptKey('codex')).toBe('session.injectGuidancePrompt.default');
  });

  it('detects claude from executable names and paths', () => {
    expect(getAgentGuidanceFile('claude')).toBe('.midterm/CLAUDE.md');
    expect(getAgentGuidanceFile('Claude.exe')).toBe('.midterm/CLAUDE.md');
    expect(getAgentGuidanceFile('"C:\\Tools\\Claude\\claude.exe" --resume')).toBe(
      '.midterm/CLAUDE.md',
    );
    expect(getInjectGuidancePromptKey('/usr/local/bin/claude')).toBe(
      'session.injectGuidancePrompt.claude',
    );
  });
});
