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

  it('keeps mobile footer controls in the adaptive dock instead of hiding automation outright', () => {
    expect(css).toContain('.mobile-topbar.has-mobile-tabs .topbar-title {');
    expect(css).toContain('.mobile-topbar .mobile-tab-strip[hidden] {');
    expect(css).toContain('.mobile-tab-pill[hidden] {');
    expect(css).toContain('.mobile-topbar.has-mobile-tabs .topbar-actions {');
    expect(css).toContain('background: var(--bg-terminal);');
    expect(css).toContain('border-image: linear-gradient(');
    expect(css).toContain('@media (max-width: 768px) {');
    expect(html).toContain('id="adaptive-footer-dock"');
    expect(css).toContain('.adaptive-footer-dock .manager-bar:not(.hidden) {');
    expect(css).toContain('.adaptive-footer-context .touch-controller.embedded {');
    expect(css).toContain('min-width: 48px;');
    expect(css).toContain('min-height: 48px;');
    expect(css).toContain('grid-template-columns: repeat(auto-fit, minmax(44px, 1fr));');
    expect(css).toContain('.adaptive-footer-context .smart-input-tools-strip {');
  });
});
