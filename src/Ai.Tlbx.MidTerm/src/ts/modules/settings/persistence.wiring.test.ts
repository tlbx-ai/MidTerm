import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { getSettingsRegistryControlEntries, SETTINGS_REGISTRY } from './registry';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../../../..');
const html = readFileSync(path.join(projectRoot, 'src/static/index.html'), 'utf8');
const settingsModelSource = readFileSync(
  path.join(projectRoot, 'Settings/MidTermSettingsPublic.cs'),
  'utf8',
);
const persistenceSource = readFileSync(
  path.join(projectRoot, 'src/ts/modules/settings/persistence.ts'),
  'utf8',
);
const cssSource = readFileSync(path.join(projectRoot, 'src/static/css/app.css'), 'utf8');
const xtermCssSource = readFileSync(path.join(projectRoot, 'src/static/css/xterm.css'), 'utf8');

const NON_PERSISTED_SETTING_IDS = new Set([
  'setting-background-upload',
  'setting-ui-transparency-value',
  'setting-terminal-transparency-value',
]);

function getPersistedSettingIds(): string[] {
  const ids = new Set<string>();

  for (const match of html.matchAll(/id="(setting-[^"]+)"/g)) {
    const id = match[1];
    if (!id || NON_PERSISTED_SETTING_IDS.has(id)) {
      continue;
    }

    ids.add(id);
  }

  return [...ids].sort();
}

function toCamelCase(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

function getPublicSettingKeys(): string[] {
  const keys = new Set<string>();

  for (const match of settingsModelSource.matchAll(/public\s+[^\s]+\s+(\w+)\s*\{/g)) {
    const key = match[1];
    if (!key) {
      continue;
    }

    keys.add(toCamelCase(key));
  }

  return [...keys].sort();
}

describe('settings persistence wiring', () => {
  it('covers every public setting in the registry', () => {
    const registeredKeys = SETTINGS_REGISTRY.map((entry) => entry.key).sort();
    expect(registeredKeys).toEqual(getPublicSettingKeys());
  });

  it('covers every persisted settings control from index.html in the registry', () => {
    const registeredIds = getSettingsRegistryControlEntries()
      .map((entry) => entry.controlId)
      .filter((id): id is string => Boolean(id))
      .sort();

    expect(registeredIds).toEqual(getPersistedSettingIds());
  });

  it('marks non-form writers explicitly in the registry', () => {
    const specialWriters = new Map(
      SETTINGS_REGISTRY.filter((entry) => entry.specialWriter).map((entry) => [
        entry.key,
        entry.specialWriter,
      ]),
    );

    expect(specialWriters.get('managerBarButtons')).toContain('managerBar');
    expect(specialWriters.get('showChangelogAfterUpdate')).toContain('changelog');
    expect(specialWriters.get('devMode')).toContain('version-click');
    expect(specialWriters.get('terminalColorSchemes')).toContain('terminal color scheme editor');
  });

  it('previews and saves font size on input', () => {
    expect(persistenceSource).toContain(
      "const fontSizeInput = document.getElementById('setting-font-size')",
    );
    expect(persistenceSource).toContain(
      "const lineHeightInput = document.getElementById('setting-line-height')",
    );
    expect(persistenceSource).toContain('const letterSpacingInput = document.getElementById(');
    expect(persistenceSource).toContain("'setting-letter-spacing'");
    expect(persistenceSource).toContain('bindTerminalFontPreview(');
  });

  it('flushes pending settings before detaching handlers', () => {
    expect(persistenceSource).toContain('function flushPendingSettingsChanges(): void');
    expect(persistenceSource).toContain('flushPendingSettingsChanges();');
  });

  it('blocks autosave until the settings form is hydrated and user interaction arms it', () => {
    expect(persistenceSource).toContain('let settingsFormHydrated = false;');
    expect(persistenceSource).toContain('let settingsSaveArmed = false;');
    expect(persistenceSource).toContain('if (!settingsFormHydrated || !settingsSaveArmed) {');
    expect(persistenceSource).toContain("settingsView.addEventListener('pointerdown', armSettingsSave");
    expect(persistenceSource).toContain("settingsView.addEventListener('keydown', armSettingsSave");
  });

  it('preserves hydration state when rebinding autosave listeners', () => {
    expect(persistenceSource).toContain('unbindSettingsAutoSave(false);');
    expect(persistenceSource).toContain(
      'export function unbindSettingsAutoSave(resetHydrationState = true): void {',
    );
    expect(persistenceSource).toContain('if (resetHydrationState) {');
  });

  it('keeps the saved run-as user selectable even if discovery misses it', () => {
    expect(persistenceSource).toContain('selectedUser &&');
    expect(persistenceSource).toContain('!users.some(');
    expect(persistenceSource).toContain("option.value = selectedUser;");
    expect(persistenceSource).toContain("option.textContent = selectedUser;");
    expect(persistenceSource).toContain('option.selected = true;');
  });

  it('uses non-submit inline save buttons for text and number settings', () => {
    const inlineSaveButtons = [
      ...html.matchAll(/<button\s+type="button"\s+class="inline-save-btn"/g),
    ];
    expect(inlineSaveButtons).toHaveLength(5);
  });

  it('keeps the background upload preview clean when an image exists', () => {
    expect(cssSource).toContain('.background-image-preview.hidden');
    expect(cssSource).toContain('.background-image-empty.hidden');
  });

  it('keeps settings surfaces opaque under UI transparency', () => {
    expect(cssSource).toContain('background-color: var(--bg-settings-opaque, var(--bg-settings));');
    expect(cssSource).toContain('background: var(--bg-elevated-opaque, var(--bg-elevated));');
    expect(cssSource).toContain('background: var(--bg-active-opaque, var(--bg-active));');
  });

  it('keeps terminal transparency out of non-xterm chrome', () => {
    expect(cssSource).not.toContain('--bg-terminal-pane');
    expect(cssSource).not.toContain('--terminal-pane-bg');
    expect(cssSource).toContain('background: var(--bg-terminal);');
    expect(cssSource).toContain('background: var(--bg-primary);');
    expect(cssSource).toContain('background: var(--terminal-ui-background, var(--terminal-bg));');
    expect(xtermCssSource).toContain(
      'background-color: var(--terminal-canvas-background, var(--bg-terminal));',
    );
  });

  it('applies reduced UI transparency to text inputs and sidebar items', () => {
    expect(cssSource).toContain('background: var(--text-input-background, var(--bg-input));');
    expect(cssSource).toContain(
      'background-color: var(--sidebar-item-hover-background, var(--bg-session-hover));',
    );
    expect(cssSource).toContain(
      'background-color: var(--sidebar-item-active-background, var(--bg-session-active));',
    );
  });

  it('allows both transparency sliders to reach 100 percent', () => {
    expect(html).toMatch(/id="setting-ui-transparency"[\s\S]*?max="100"/);
    expect(html).toMatch(/id="setting-terminal-transparency"[\s\S]*?max="100"/);
    expect(SETTINGS_REGISTRY.find((entry) => entry.key === 'uiTransparency')?.validation).toBe(
      'integer, clamped to 0-100',
    );
    expect(
      SETTINGS_REGISTRY.find((entry) => entry.key === 'terminalTransparency')?.validation,
    ).toBe('integer, clamped to 0-100');
  });

  it('renders a dedicated custom terminal scheme editor', () => {
    expect(html).toContain('id="terminal-color-scheme-editor"');
    expect(html).toContain('id="terminal-color-scheme-editor-name"');
    expect(html).toContain('id="terminal-color-scheme-editor-source"');
    expect(html).toContain('id="terminal-color-scheme-save"');
    expect(cssSource).toContain('.terminal-color-scheme-editor');
  });

  it('rebuilds the terminal color scheme select with custom entries at runtime', () => {
    expect(persistenceSource).toContain('syncTerminalColorSchemeOptions(settings);');
    expect(persistenceSource).toContain('appendTranslatedOption(');
    expect(persistenceSource).toContain("group.label = 'Custom Schemes'");
    expect(persistenceSource).toContain('terminalColorSchemes.length');
    expect(persistenceSource).toContain("document.getElementById('terminal-color-scheme-save')");
  });
});
