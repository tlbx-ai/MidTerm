import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');
const html = readFileSync(path.join(projectRoot, 'src/static/index.html'), 'utf8');
const css = readFileSync(path.join(projectRoot, 'src/static/css/app.css'), 'utf8');
const mainSource = readFileSync(path.join(projectRoot, 'src/ts/main.ts'), 'utf8');

describe('mobile responsive chrome wiring', () => {
  it('nests the mobile tab strip inside the mobile topbar', () => {
    expect(html).toMatch(
      /<header class="mobile-topbar" id="mobile-topbar">[\s\S]*?<div class="topbar-title" id="mobile-title">[\s\S]*?<nav class="mobile-tab-strip" id="mobile-tab-strip"[\s\S]*?<div class="topbar-actions no-terminal" id="topbar-actions">/,
    );
  });

  it('toggles merged mobile topbar state from the active session', () => {
    expect(mainSource).toContain("title?.toggleAttribute('hidden', Boolean(activeSessionId));");
    expect(mainSource).toContain(
      "topbar?.classList.toggle('has-mobile-tabs', Boolean(activeSessionId));",
    );
    expect(mainSource).toContain(
      "const agentSurfaceSession = resolveSessionSurfaceMode(activeSession) === 'agent';",
    );
    expect(mainSource).toContain(
      "activeSessionId !== null && agentSurfaceSession && isTabAvailable(activeSessionId, 'agent');",
    );
  });

  it('keeps the smart input textarea on its own row only in mobile layouts', () => {
    expect(css).toContain('.mobile-topbar.has-mobile-tabs .topbar-title {');
    expect(css).toContain('.mobile-topbar .mobile-tab-strip[hidden] {');
    expect(css).toContain('.mobile-tab-pill[hidden] {');
    expect(css).toContain('.mobile-topbar.has-mobile-tabs .topbar-actions {');
    expect(css).toContain('background: var(--bg-terminal);');
    expect(css).toContain('border-image: linear-gradient(');
    expect(css).toContain('@media (max-width: 768px) {');
    expect(css).toContain('.smart-input-row {');
    expect(css).toContain('order: -1;');
    expect(css).toContain('flex: 1 0 100%;');
  });
});
