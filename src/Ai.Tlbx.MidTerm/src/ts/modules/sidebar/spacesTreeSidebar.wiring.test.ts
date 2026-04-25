import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(path.join(__dirname, 'spacesTreeSidebar.ts'), 'utf8');
const css = readFileSync(path.join(__dirname, '../../../static/css/app.css'), 'utf8');
const locale = readFileSync(path.join(__dirname, '../../../static/locales/en.json'), 'utf8');

describe('spacesTreeSidebar wiring', () => {
  it('does not render a dedicated spaces empty-state badge', () => {
    expect(source).not.toContain('spaces-sidebar-empty');
    expect(source).not.toContain("t('spaces.noSearchMatches')");
    expect(source).not.toContain("t('spaces.sidebarEmpty')");
    expect(css).not.toContain('.spaces-sidebar-empty');
    expect(locale).not.toContain('"spaces.noSearchMatches"');
    expect(locale).not.toContain('"spaces.sidebarEmpty"');
  });

  it('patches foreground process changes without routing through full tree render', () => {
    expect(source).toContain('addProcessStateListener(queueSidebarSessionProcessInfoUpdate)');
    expect(source).not.toContain('addProcessStateListener(queueSidebarTreeRender)');
  });

  it('does not rebuild the whole sidebar for normal space expand-collapse clicks', () => {
    expect(source).toContain('patchSpaceNodeExpandedContent(node, machineId, space)');
    expect(source).toContain('removeSpaceNodeExpandedContent(node)');
    expect(source).not.toContain('toggleSpaceExpanded(machineId: string | null, spaceId: string');
  });

  it('reconciles the sidebar tree instead of replacing the host children', () => {
    expect(source).toContain('reconcileKeyedChildren(host, getSidebarRootItems()');
    expect(source).toContain('reconcileSidebarSessions');
    expect(source).not.toContain('host.replaceChildren()');
  });

  it('keeps session row actions for rename and collapsible notes', () => {
    expect(source).toContain("renameButton.className = 'session-rename'");
    expect(source).toContain('callbacks?.onRename(entry.id)');
    expect(source).toContain('notesButton.className = `session-notes-toggle');
    expect(source).toContain("notesButton.setAttribute('aria-expanded'");
    expect(source).toContain('toggleSessionNotes(entry.id)');
    expect(css).toContain('.session-notes-pane');
    expect(css).toContain('.session-notes-input');
    expect(locale).toContain('"session.notes"');
  });

  it('patches session notes inside keyed rows instead of rebuilding the tree', () => {
    expect(source).toContain('syncSessionNotesPane(notesPane, entry)');
    expect(source).toContain('apiSetSessionNotes(sessionId, notes)');
    expect(source).not.toContain('notesPane.replaceChildren');
  });
});
