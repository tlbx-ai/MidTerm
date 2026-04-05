import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appCss = readFileSync(path.join(__dirname, '../../../static/css/app.css'), 'utf8');
const constants = readFileSync(path.join(__dirname, '../../constants.ts'), 'utf8');
const managerSource = readFileSync(path.join(__dirname, 'manager.ts'), 'utf8');
const scalingSource = readFileSync(path.join(__dirname, 'scaling.ts'), 'utf8');

describe('terminal surface wiring', () => {
  it('removes terminal panel inset padding from sizing and chrome', () => {
    expect(constants).toContain('export const TERMINAL_PADDING = 0;');
    expect(appCss).toContain('.terminal-container {');
    expect(appCss).toContain('padding: 0;');
    expect(appCss).toContain(
      'background-color: var(--terminal-canvas-background, var(--terminal-bg));',
    );
  });

  it('lets the xterm host cover floor-to-cell remainder space inside the panel', () => {
    expect(appCss).toContain('.terminal-container .xterm {');
    expect(appCss).toContain('min-width: 100%;');
    expect(appCss).toContain('min-height: 100%;');
    expect(appCss).toContain(
      'background-color: var(--terminal-canvas-background, var(--terminal-bg));',
    );
  });

  it('keeps terminal content above the Command Bay and refreshes when footer reserve changes', () => {
    expect(appCss).toContain('.layout-leaf .terminal-container {');
    expect(appCss).toContain('bottom: var(--adaptive-footer-reserved-height);');
    expect(scalingSource).toContain('ADAPTIVE_FOOTER_RESERVED_HEIGHT_CHANGED_EVENT');
    expect(scalingSource).toContain('scheduleFooterReserveResize();');
  });

  it('wires custom box-drawing glyph rendering to persisted terminal settings', () => {
    expect(managerSource).toContain('const customGlyphs = currentSettings?.customGlyphs ?? true;');
    expect(managerSource).toContain('customGlyphs: customGlyphs,');
  });
});
