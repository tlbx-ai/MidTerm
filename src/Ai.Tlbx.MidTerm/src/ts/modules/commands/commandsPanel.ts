/**
 * Commands Panel
 *
 * Main commands list UI with run buttons and inline forms.
 */

import { escapeHtml } from '../../utils';
import type { CommandDefinition } from './commandsApi';
import {
  fetchCommands,
  createCommand,
  updateCommand,
  deleteCommand,
  runCommand,
} from './commandsApi';
import { createCommandForm, type CommandFormData } from './commandForm';
import { showOutput } from './outputPanel';

interface CommandsPanelState {
  sessionId: string;
  container: HTMLElement;
  commands: CommandDefinition[];
  showForm: boolean;
  editingFilename: string | null;
  activeRunId: string | null;
}

const panelStates = new Map<string, CommandsPanelState>();

export function createCommandsPanel(container: HTMLElement, sessionId: string): void {
  const state: CommandsPanelState = {
    sessionId,
    container,
    commands: [],
    showForm: false,
    editingFilename: null,
    activeRunId: null,
  };
  panelStates.set(sessionId, state);
  renderPanel(state);
}

export async function refreshCommandsPanel(sessionId: string): Promise<void> {
  const state = panelStates.get(sessionId);
  if (!state) return;

  const result = await fetchCommands(sessionId);
  if (result) {
    state.commands = result.commands;
    renderPanel(state);
  }
}

export function destroyCommandsPanel(sessionId: string): void {
  panelStates.delete(sessionId);
}

function renderPanel(state: CommandsPanelState): void {
  const { container, commands, showForm, editingFilename, activeRunId } = state;

  let html = '<div class="commands-panel">';

  html += '<div class="commands-list">';
  if (commands.length === 0 && !showForm) {
    html += `<div class="commands-empty">
      <p>No commands defined</p>
      <p class="commands-hint">Create command files in .midterm/commands/</p>
    </div>`;
  }

  for (const cmd of commands) {
    if (editingFilename === cmd.filename) {
      html += `<div class="command-edit-slot" data-filename="${escapeHtml(cmd.filename)}"></div>`;
      continue;
    }

    html += `<div class="command-item" data-filename="${escapeHtml(cmd.filename)}">
      <div class="command-item-info">
        <span class="command-item-name">${escapeHtml(cmd.name)}</span>
        <span class="command-item-desc">${escapeHtml(cmd.description)}</span>
      </div>
      <div class="command-item-actions">
        <button class="command-run-btn" data-filename="${escapeHtml(cmd.filename)}" title="Run">\u25B6</button>
        <button class="command-edit-btn" data-filename="${escapeHtml(cmd.filename)}" title="Edit">\u270E</button>
        <button class="command-delete-btn" data-filename="${escapeHtml(cmd.filename)}" title="Delete">\u2715</button>
      </div>
    </div>`;
  }
  html += '</div>';

  if (showForm) {
    html += '<div class="command-create-slot"></div>';
  } else {
    html += '<button class="command-add-btn">+ New Command</button>';
  }

  if (activeRunId) {
    html += '<div class="command-output-area"></div>';
  }

  html += '</div>';
  container.innerHTML = html;
  bindEvents(state);
}

function bindEvents(state: CommandsPanelState): void {
  const { container, sessionId, commands } = state;

  container.querySelectorAll('.command-run-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const filename = (btn as HTMLElement).dataset.filename;
      if (!filename) return;

      const runId = await runCommand(sessionId, filename);
      if (runId) {
        state.activeRunId = runId;
        renderPanel(state);

        const outputArea = container.querySelector('.command-output-area') as HTMLElement;
        if (outputArea) {
          showOutput(outputArea, runId, () => {
            state.activeRunId = null;
          });
        }
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
      const cmd = commands.find((c) => c.filename === filename);
      if (slot && cmd) {
        createCommandForm(
          slot,
          cmd,
          async (data: CommandFormData) => {
            await updateCommand(filename, sessionId, data.name, data.description, data.commands);
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
      if (!confirm('Delete this command?')) return;
      await deleteCommand(filename, sessionId);
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
        async (data: CommandFormData) => {
          await createCommand(sessionId, data.name, data.description, data.commands);
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
