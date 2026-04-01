import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const source = readFileSync(path.join(__dirname, 'events.ts'), 'utf8');

describe('touch controller Lens escape wiring', () => {
  it('routes plain Esc presses through Lens interruption for Lens-owned sessions', () => {
    expect(source).toContain("if (key === 'esc' && !mods.ctrl && !mods.alt && !mods.shift && isLensActiveSession(sessionId)) {");
    expect(source).toContain('void handleLensEscape(sessionId);');
  });
});
