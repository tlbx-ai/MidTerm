/**
 * Commands Panel
 *
 * Script list UI with run/edit/delete buttons and inline forms.
 */

import { escapeHtml } from '../../utils';
import { t } from '../i18n';
import { showConfirm } from '../../utils/dialog';
import type { ScriptDefinition } from './commandsApi';
import {
  fetchScripts,
  createScript,
  updateScript,
  deleteScript,
  runScript,
  stopScript,
  getRunningSessionId,
  setRunningScript,
  clearRunningScript,
  clearRunningScriptBySessionId,
} from './commandsApi';
import { createCommandForm, type ScriptFormData } from './commandForm';
import { showOutputOverlay, closeOverlay } from './outputPanel';

interface CommandsPanelState {
  sessionId: string;
  container: HTMLElement;
  scripts: ScriptDefinition[];
  showForm: boolean;
  editingFilename: string | null;
  eventsBound: boolean;
}

const panelStates = new Map<string, CommandsPanelState>();

export function createCommandsPanel(container: HTMLElement, sessionId: string): void {
  const state: CommandsPanelState = {
    sessionId,
    container,
    scripts: [],
    showForm: false,
    editingFilename: null,
    eventsBound: false,
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

export function handleHiddenSessionClosed(hiddenSessionId: string): void {
  const filename = clearRunningScriptBySessionId(hiddenSessionId);
  if (filename) {
    for (const state of panelStates.values()) {
      if (state.scripts.some((s) => s.filename === filename)) {
        renderPanel(state);
        break;
      }
    }
  }
}

function renderPanel(state: CommandsPanelState): void {
  const { container, scripts, showForm, editingFilename } = state;

  let html = '<div class="commands-panel">';

  html += '<div class="commands-list">';
  if (scripts.length === 0 && !showForm) {
    html += `<div class="commands-empty">
      <p>${t('commands.noScripts')}</p>
      <p class="commands-hint">${t('commands.createHint')}</p>
    </div>`;
  }

  for (const script of scripts) {
    if (editingFilename === script.filename) {
      html += `<div class="command-edit-slot" data-filename="${escapeHtml(script.filename)}"></div>`;
      continue;
    }

    const running = getRunningSessionId(script.filename);
    const runBtn = running
      ? `<button class="command-stop-btn" data-filename="${escapeHtml(script.filename)}" title="${t('commands.stop')}">\u25A0</button>`
      : `<button class="command-run-btn" data-filename="${escapeHtml(script.filename)}" title="${t('commands.run')}">\u25B6</button>`;

    html += `<div class="command-item" data-filename="${escapeHtml(script.filename)}">
      <div class="command-item-info">
        <span class="command-item-name">${escapeHtml(script.name)}</span>
        <span class="command-item-ext">${escapeHtml(script.extension)}</span>
      </div>
      <div class="command-item-actions">
        ${runBtn}
        <button class="command-edit-btn" data-filename="${escapeHtml(script.filename)}" title="${t('commands.edit')}">\u270E</button>
        <button class="command-delete-btn" data-filename="${escapeHtml(script.filename)}" title="${t('commands.delete')}">\u2715</button>
      </div>
    </div>`;
  }
  html += '</div>';

  html += '<div class="commands-panel-toolbar">';
  if (showForm) {
    html += '<div class="command-create-slot"></div>';
  } else {
    html += `<button class="command-add-btn">+ ${t('commands.newScript')}</button>`;
  }
  html += '</div>';

  html += '</div>';
  container.innerHTML = html;
  ensureEventsBound(state);
}

export async function renderCommandsPanelInto(
  container: HTMLElement,
  sessionId: string,
): Promise<void> {
  let state = panelStates.get(sessionId);
  if (!state) {
    state = {
      sessionId,
      container,
      scripts: [],
      showForm: false,
      editingFilename: null,
      eventsBound: false,
    };
    panelStates.set(sessionId, state);
  } else {
    state.container = container;
  }

  const result = await fetchScripts(sessionId);
  if (result) {
    state.scripts = result.scripts;
  }
  renderPanel(state);
}

function ensureEventsBound(state: CommandsPanelState): void {
  if (state.eventsBound) return;
  state.eventsBound = true;

  state.container.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;

    const button = target.closest<HTMLButtonElement>('button');
    if (!button) return;

    const filename = button.dataset.filename;

    if (button.classList.contains('command-run-btn') && filename) {
      void handleRunClick(state, filename);
      return;
    }

    if (button.classList.contains('command-stop-btn') && filename) {
      void handleStopClick(state, filename);
      return;
    }

    if (button.classList.contains('command-edit-btn') && filename) {
      handleEditClick(state, filename);
      return;
    }

    if (button.classList.contains('command-delete-btn') && filename) {
      void handleDeleteClick(state, filename);
      return;
    }

    if (button.classList.contains('command-add-btn')) {
      handleAddClick(state);
    }
  });
}

function getScriptByFilename(
  state: CommandsPanelState,
  filename: string,
): ScriptDefinition | undefined {
  return state.scripts.find((script) => script.filename === filename);
}

async function handleRunClick(state: CommandsPanelState, filename: string): Promise<void> {
  const result = await runScript(state.sessionId, filename);
  if (!result) return;

  setRunningScript(filename, result.hiddenSessionId);
  const script = getScriptByFilename(state, filename);
  showOutputOverlay(result.hiddenSessionId, script?.name ?? filename);
  renderPanel(state);
}

async function handleStopClick(state: CommandsPanelState, filename: string): Promise<void> {
  const hiddenId = getRunningSessionId(filename);
  if (!hiddenId) return;

  await stopScript(hiddenId);
  closeOverlay(hiddenId);
  clearRunningScript(filename);
  renderPanel(state);
}

function handleEditClick(state: CommandsPanelState, filename: string): void {
  state.editingFilename = filename;
  renderPanel(state);

  const slot = state.container.querySelector<HTMLElement>(
    `.command-edit-slot[data-filename="${filename}"]`,
  );
  const script = getScriptByFilename(state, filename);
  if (!slot || !script) return;

  createCommandForm(
    slot,
    script,
    (data: ScriptFormData) => {
      void (async () => {
        await updateScript(filename, state.sessionId, data.content);
        state.editingFilename = null;
        await refreshCommandsPanel(state.sessionId);
      })();
    },
    () => {
      state.editingFilename = null;
      renderPanel(state);
    },
  );
}

async function handleDeleteClick(state: CommandsPanelState, filename: string): Promise<void> {
  const ok = await showConfirm(t('commands.deleteConfirm'));
  if (!ok) return;

  await deleteScript(filename, state.sessionId);
  await refreshCommandsPanel(state.sessionId);
}

function handleAddClick(state: CommandsPanelState): void {
  state.showForm = true;
  renderPanel(state);

  const slot = state.container.querySelector<HTMLElement>('.command-create-slot');
  if (!slot) return;

  createCommandForm(
    slot,
    undefined,
    (data: ScriptFormData) => {
      void (async () => {
        await createScript(state.sessionId, data.name, data.extension, data.content);
        state.showForm = false;
        await refreshCommandsPanel(state.sessionId);
      })();
    },
    () => {
      state.showForm = false;
      renderPanel(state);
    },
  );
}
