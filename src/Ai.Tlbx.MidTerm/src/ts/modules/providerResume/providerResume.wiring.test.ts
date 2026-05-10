import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const source = readFileSync(path.join(__dirname, 'index.ts'), 'utf8');
const css = readFileSync(path.join(__dirname, '../../../static/css/app.css'), 'utf8');

describe('provider resume picker wiring', () => {
  it('loads provider-owned resume candidates through the shared picker helper', () => {
    expect(source).toContain('getProviderResumeCandidates');
    expect(source).toContain('scope: activeScope');
    expect(source).toContain('Resume Conversation');
    expect(source).toContain('This folder');
    expect(source).toContain('All');
  });

  it('renders the picker in a dedicated modal list layout', () => {
    expect(css).toContain('.provider-resume-picker-list {');
    expect(css).toContain('.provider-resume-picker-row {');
    expect(css).toContain('.provider-resume-picker-scope-btn.active {');
  });
});
