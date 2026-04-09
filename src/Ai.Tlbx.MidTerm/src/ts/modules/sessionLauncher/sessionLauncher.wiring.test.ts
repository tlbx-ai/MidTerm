import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const source = readFileSync(path.join(__dirname, 'index.ts'), 'utf8');
const css = readFileSync(path.join(__dirname, '../../../static/css/app.css'), 'utf8');

describe('session launcher visibility wiring', () => {
  it('keeps hidden launcher sections out of layout even when their classes set display', () => {
    expect(css).toContain('.session-launcher-launch[hidden],');
    expect(css).toContain('.session-launcher-browser[hidden],');
    expect(css).toContain('.session-launcher-remote[hidden] {');
    expect(css).toContain('display: none !important;');
  });

  it('loads per-target picker roots and start paths before browsing directories', () => {
    expect(source).toContain(
      'resetLauncherBrowserState(state, pathResponse, rootsResponse.entries);',
    );
    expect(source).toContain('fetchHomePath(target),');
    expect(source).toContain('fetchLauncherRoots(target),');
    expect(source).toContain('const initialPath = options?.path?.trim() || state.startPath;');
  });

  it('splits Codex and Claude launch cards into new and resume actions', () => {
    expect(source).toContain('data-launch-mode="new"');
    expect(source).toContain('data-launch-mode="resume"');
    expect(source).toContain('New Conversation');
    expect(source).toContain('Resume Conversation');
    expect(source).toContain('openProviderResumePicker');
    expect(css).toContain('.session-launcher-provider-actions {');
  });

  it('adds folder and clone actions while moving the directory field onto its own row', () => {
    expect(source).toContain('data-action="new-folder"');
    expect(source).toContain('data-action="clone-repo"');
    expect(source).toContain('showTextPrompt');
    expect(source).toContain('getLauncherApiBasePath(target)');
    expect(css).toContain('grid-template-columns: repeat(4, minmax(0, 1fr));');
    expect(css).toContain('.session-launcher-path {');
    expect(css).toContain('grid-column: 1 / -1;');
  });
});
