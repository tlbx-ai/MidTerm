import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const source = readFileSync(path.join(__dirname, 'tabs.ts'), 'utf8');

describe('settings tab migration', () => {
  it('maps legacy settings tabs to the new top-level tabs', () => {
    expect(source).toContain("case 'general':");
    expect(source).toContain("return 'updates';");
    expect(source).toContain("case 'command-bay':");
    expect(source).toContain("return 'workflow';");
    expect(source).toContain("case 'diagnostics':");
    expect(source).toContain("return 'advanced';");
    expect(source).toContain("case 'behavior':");
    expect(source).toContain("return 'workflow';");
    expect(source).toContain("case 'agent-ui':");
    expect(source).toContain("return 'ai-agents';");
  });

  it('defines the new top-level settings tabs as valid', () => {
    expect(source).toContain("| 'updates'");
    expect(source).toContain("| 'workflow'");
    expect(source).toContain("| 'sessions'");
    expect(source).toContain("| 'terminal'");
    expect(source).toContain("| 'ai-agents'");
    expect(source).toContain("| 'connected-hosts'");
    expect(source).toContain("| 'advanced'");
    expect(source).toContain("'updates',");
    expect(source).toContain("'workflow',");
    expect(source).toContain("'sessions',");
    expect(source).toContain("'terminal',");
    expect(source).toContain("'ai-agents',");
    expect(source).toContain("'connected-hosts',");
    expect(source).toContain("'advanced',");
  });
});
