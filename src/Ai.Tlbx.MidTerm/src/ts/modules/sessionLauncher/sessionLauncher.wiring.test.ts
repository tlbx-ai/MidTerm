import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const source = readFileSync(path.join(__dirname, 'index.ts'), 'utf8');
const css = readFileSync(path.join(__dirname, '../../../static/css/app.css'), 'utf8');

describe('session launcher visibility wiring', () => {
  it('switches between the local browser and remote path field based on target type', () => {
    expect(source).toContain('sections.localBrowser.hidden = !isLocalTarget;');
    expect(source).toContain('sections.remoteBrowser.hidden = isLocalTarget;');
  });

  it('keeps hidden launcher sections out of layout even when their classes set display', () => {
    expect(css).toContain('.session-launcher-launch[hidden],');
    expect(css).toContain('.session-launcher-browser[hidden],');
    expect(css).toContain('.session-launcher-remote[hidden] {');
    expect(css).toContain('display: none !important;');
  });
});
