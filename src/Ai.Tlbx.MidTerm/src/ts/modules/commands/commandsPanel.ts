/**
 * Commands Panel
 *
 * Script list UI with run/edit/delete buttons and inline forms.
 */

import { escapeHtml } from '../../utils';
import type { ScriptDefinition } from './commandsApi';
import { fetchScripts, createScript, updateScript, deleteScript, runScript } from './commandsApi';
import { createCommandForm, type ScriptFormData } from './commandForm';
import { showOutputOverlay } from './outputPanel';

interface CommandsPanelState {
  sessionId: string;
  container: HTMLElement;
  scripts: ScriptDefinition[];
  showForm: boolean;
  editingFilename: string | null;
}

const panelStates = new Map<string, CommandsPanelState>();

export function createCommandsPanel(container: HTMLElement, sessionId: string): void {
  const state: CommandsPanelState = {
    sessionId,
    container,
    scripts: [],
    showForm: false,
    editingFilename: null,
  };
  panelStates.set(sessionId, state);
  renderPanel(state);
}

export async function refreshCommandsPanel(sessionId: string): Promise<void> {
  const state = panelStates.get(sessionId);
  if (!state) return;

  const result = await fetchScripts(sessionId);
  if (result) {
    state.scripts = result.scripts;
    renderPanel(state);
  }
}

export function destroyCommandsPanel(sessionId: string): void {
  panelStates.delete(sessionId);
}

function renderPanel(state: CommandsPanelState): void {
  const { container, scripts, showForm, editingFilename } = state;

  let html = '<div class="commands-panel">';

  html += '<div class="commands-list">';
  if (scripts.length === 0 && !showForm) {
    html += `<div class="commands-empty">
      <p>No scripts found</p>
      <p class="commands-hint">Create script files in .midterm/</p>
    </div>`;
  }

  for (const script of scripts) {
    if (editingFilename === script.filename) {
      html += `<div class="command-edit-slot" data-filename="${escapeHtml(script.filename)}"></div>`;
      continue;
    }

    html += `<div class="command-item" data-filename="${escapeHtml(script.filename)}">
      <div class="command-item-info">
        <span class="command-item-name">${escapeHtml(script.name)}</span>
        <span class="command-item-ext">${escapeHtml(script.extension)}</span>
      </div>
      <div class="command-item-actions">
        <button class="command-run-btn" data-filename="${escapeHtml(script.filename)}" title="Run">\u25B6</button>
        <button class="command-edit-btn" data-filename="${escapeHtml(script.filename)}" title="Edit">\u270E</button>
        <button class="command-delete-btn" data-filename="${escapeHtml(script.filename)}" title="Delete">\u2715</button>
      </div>
    </div>`;
  }
  html += '</div>';

  if (showForm) {
    html += '<div class="command-create-slot"></div>';
  } else {
    html += '<button class="command-add-btn">+ New Script</button>';
  }

  html += '</div>';
  container.innerHTML = html;
  bindEvents(state);
}

function bindEvents(state: CommandsPanelState): void {
  const { container, sessionId, scripts } = state;

  container.querySelectorAll('.command-run-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const filename = (btn as HTMLElement).dataset.filename;
      if (!filename) return;

      const result = await runScript(sessionId, filename);
      if (result) {
        const script = scripts.find((s) => s.filename === filename);
        showOutputOverlay(result.hiddenSessionId, script?.name ?? filename);
      }
    });
  });

  container.querySelectorAll('.command-edit-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const filename = (btn as HTMLElement).dataset.filename;
      if (!filename) return;
      state.editingFilename = filename;
      renderPanel(state);

      const slot = container.querySelector(
        `.command-edit-slot[data-filename="${filename}"]`,
      ) as HTMLElement;
      const script = scripts.find((s) => s.filename === filename);
      if (slot && script) {
        createCommandForm(
          slot,
          script,
          async (data: ScriptFormData) => {
            await updateScript(filename, sessionId, data.content);
            state.editingFilename = null;
            await refreshCommandsPanel(sessionId);
          },
          () => {
            state.editingFilename = null;
            renderPanel(state);
          },
        );
      }
    });
  });

  container.querySelectorAll('.command-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const filename = (btn as HTMLElement).dataset.filename;
      if (!filename) return;
      if (!confirm('Delete this script?')) return;
      await deleteScript(filename, sessionId);
      await refreshCommandsPanel(sessionId);
    });
  });

  container.querySelector('.command-add-btn')?.addEventListener('click', () => {
    state.showForm = true;
    renderPanel(state);

    const slot = container.querySelector('.command-create-slot') as HTMLElement;
    if (slot) {
      createCommandForm(
        slot,
        undefined,
        async (data: ScriptFormData) => {
          await createScript(sessionId, data.name, data.extension, data.content);
          state.showForm = false;
          await refreshCommandsPanel(sessionId);
        },
        () => {
          state.showForm = false;
          renderPanel(state);
        },
      );
    }
  });
}
