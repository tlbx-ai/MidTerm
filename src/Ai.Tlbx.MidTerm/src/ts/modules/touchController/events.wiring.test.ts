import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const source = readFileSync(path.join(__dirname, 'events.ts'), 'utf8');

describe('touch controller AppServerControl escape wiring', () => {
  it('routes plain Esc presses through AppServerControl interruption for AppServerControl-owned sessions', () => {
    expect(source).toMatch(
      /key === 'esc'[\s\S]*!mods\.ctrl[\s\S]*!mods\.alt[\s\S]*!mods\.shift[\s\S]*isAppServerControlActiveSession\(sessionId\)/,
    );
    expect(source).toContain('void handleAppServerControlEscape(sessionId);');
  });
});
