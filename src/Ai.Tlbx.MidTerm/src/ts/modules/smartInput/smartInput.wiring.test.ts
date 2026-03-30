import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const source = readFileSync(path.join(__dirname, 'smartInput.ts'), 'utf8');

describe('smart input tab wiring', () => {
  it('resyncs smart input visibility when non-Lens tabs activate', () => {
    expect(source).toContain("onTabActivated('agent', (sessionId) => {");
    expect(source).toContain("onTabActivated('terminal', (sessionId) => {");
    expect(source).toContain("onTabActivated('files', (sessionId) => {");
  });

  it('does not rely on agent deactivation timing to hide Lens-only controls', () => {
    expect(source).not.toContain("onTabDeactivated('agent'");
  });
});
