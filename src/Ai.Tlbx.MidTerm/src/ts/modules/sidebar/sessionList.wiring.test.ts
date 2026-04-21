import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const source = readFileSync(path.join(__dirname, 'sessionList.ts'), 'utf8');

describe('session list wiring', () => {
  it('switches desktop sessions on pointerdown while keeping click fallback for touch and keyboard', () => {
    expect(source).toContain("item.addEventListener('pointerdown', (event) => {");
    expect(source).toContain("event.pointerType === 'touch'");
    expect(source).toContain("item.addEventListener('click', (event) => {");
    expect(source).toContain('if (Date.now() - lastImmediateSelectionAt < 750) {');
  });
});
