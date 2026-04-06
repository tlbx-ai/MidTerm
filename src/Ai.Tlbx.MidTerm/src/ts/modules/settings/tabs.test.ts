import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const source = readFileSync(path.join(__dirname, 'tabs.ts'), 'utf8');

describe('settings tab migration', () => {
  it('maps legacy settings tabs to the new top-level tabs', () => {
    expect(source).toContain("case 'behavior':");
    expect(source).toContain("return 'terminal';");
    expect(source).toContain("case 'agent-ui':");
    expect(source).toContain("return 'agent';");
  });

  it('defines the new command-bay, terminal, and agent tabs as valid top-level tabs', () => {
    expect(source).toContain("| 'command-bay'");
    expect(source).toContain("| 'terminal'");
    expect(source).toContain("| 'agent'");
    expect(source).toContain("'command-bay',");
    expect(source).toContain("'terminal',");
    expect(source).toContain("'agent',");
  });
});
