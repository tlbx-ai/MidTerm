/**
 * WYSIWYG node editor for the Action Graphs canvas: form fields for the typed
 * node attributes, a contenteditable rich-HTML body with a minimal formatting
 * toolbar, and an action-list editor. Saves through the graph CRUD API.
 */

import { t } from '../i18n';
import {
  createNode,
  updateNode,
  type ActionGraphNode,
  type ActionGraphNodeAction,
  type UpsertNodePayload,
} from './graphApi';

const KNOWN_KINDS = [
  'identity',
  'email',
  'appointment',
  'todo',
  'project',
  'task',
  'asset',
  'plan',
  'note',
  'repo',
  'place',
  'server',
  'application',
  'service',
  'secret',
];

const PROFILES = ['terminal', 'claude', 'codex', 'grok'];

interface EditorOptions {
  graphId: string;
  node: ActionGraphNode | null;
  position: { x: number; y: number } | null;
  onSaved: () => void;
  onCancel: () => void;
}

interface EditorFields {
  title: HTMLInputElement;
  kind: HTMLInputElement;
  state: HTMLInputElement;
  date: HTMLInputElement;
  url: HTMLInputElement;
  path: HTMLInputElement;
  project: HTMLInputElement;
  body: HTMLElement;
  actionsHost: HTMLElement;
}

export function renderNodeEditor(host: HTMLElement, options: EditorOptions): void {
  const { node } = options;
  host.replaceChildren();

  const form = document.createElement('form');
  form.className = 'ag-editor';
  form.addEventListener('submit', (event) => {
    event.preventDefault();
  });

  const fields = buildFields(form, node);

  const errorLine = document.createElement('p');
  errorLine.className = 'ag-editor-error hidden';
  form.appendChild(errorLine);

  const buttons = document.createElement('div');
  buttons.className = 'ag-editor-buttons';
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'ag-editor-save';
  save.textContent = t('actionGraphs.save');
  save.addEventListener('click', () => {
    const payload = buildPayload(fields, node, options.position);
    save.disabled = true;
    errorLine.classList.add('hidden');
    const request = node
      ? updateNode(options.graphId, node.id, payload)
      : createNode(options.graphId, payload);
    void request
      .then(() => {
        options.onSaved();
      })
      .catch((error: unknown) => {
        errorLine.textContent = String(error);
        errorLine.classList.remove('hidden');
        save.disabled = false;
      });
  });
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'ag-editor-cancel';
  cancel.textContent = t('actionGraphs.cancel');
  cancel.addEventListener('click', () => {
    options.onCancel();
  });
  buttons.append(save, cancel);
  form.appendChild(buttons);

  host.appendChild(form);
  fields.title.focus();
}

interface EditorSeed {
  title: string;
  kind: string;
  state: string;
  date: string;
  url: string;
  path: string;
  project: string;
}

function seedValues(node: ActionGraphNode | null): EditorSeed {
  if (!node) {
    return { title: '', kind: 'identity', state: '', date: '', url: '', path: '', project: '' };
  }
  return {
    title: node.title,
    kind: node.kind,
    state: node.state ?? '',
    date: toLocalDateTime(node.date),
    url: node.url ?? '',
    path: node.path ?? node.host ?? '',
    project: node.project ?? '',
  };
}

function buildFields(form: HTMLFormElement, node: ActionGraphNode | null): EditorFields {
  const seed = seedValues(node);
  const title = fieldInput(form, t('actionGraphs.fieldTitle'), seed.title, 'text');
  const kind = fieldInput(form, t('actionGraphs.kind'), seed.kind, 'text', 'ag-kinds');
  const kinds = document.createElement('datalist');
  kinds.id = 'ag-kinds';
  for (const known of KNOWN_KINDS) {
    const option = document.createElement('option');
    option.value = known;
    kinds.appendChild(option);
  }
  form.appendChild(kinds);
  const state = fieldInput(form, t('actionGraphs.state'), seed.state, 'text');
  const date = fieldInput(form, t('actionGraphs.date'), seed.date, 'datetime-local');
  const url = fieldInput(form, 'URL', seed.url, 'text');
  const path = fieldInput(form, t('actionGraphs.path'), seed.path, 'text');
  const project = fieldInput(form, t('actionGraphs.project'), seed.project, 'text');

  const body = buildBodyField(form, node);
  const actionsHost = buildActionsField(form, node);

  return { title, kind, state, date, url, path, project, body, actionsHost };
}

function buildBodyField(form: HTMLFormElement, node: ActionGraphNode | null): HTMLElement {
  const bodyLabel = document.createElement('label');
  bodyLabel.className = 'ag-editor-label';
  bodyLabel.textContent = t('actionGraphs.fieldBody');
  form.appendChild(bodyLabel);
  const toolbar = buildToolbar();
  form.appendChild(toolbar.element);
  const body = document.createElement('div');
  body.className = 'ag-editor-body';
  body.contentEditable = 'true';
  body.innerHTML = node?.html ?? '';
  form.appendChild(body);
  toolbar.bind(body);
  return body;
}

function buildActionsField(form: HTMLFormElement, node: ActionGraphNode | null): HTMLElement {
  const actionsLabel = document.createElement('label');
  actionsLabel.className = 'ag-editor-label';
  actionsLabel.textContent = t('actionGraphs.fieldActions');
  form.appendChild(actionsLabel);
  const actionsHost = document.createElement('div');
  actionsHost.className = 'ag-editor-actions';
  form.appendChild(actionsHost);
  for (const action of node?.actions ?? []) {
    actionsHost.appendChild(buildActionRow(action));
  }
  const addAction = document.createElement('button');
  addAction.type = 'button';
  addAction.className = 'ag-editor-add-action';
  addAction.textContent = `+ ${t('actionGraphs.addAction')}`;
  addAction.addEventListener('click', () => {
    actionsHost.appendChild(buildActionRow(null));
  });
  form.appendChild(addAction);
  return actionsHost;
}

function buildPayload(
  fields: EditorFields,
  node: ActionGraphNode | null,
  position: { x: number; y: number } | null,
): UpsertNodePayload {
  const payload: UpsertNodePayload = {
    title: fields.title.value.trim(),
    kind: fields.kind.value.trim() || 'identity',
    state: fields.state.value.trim(),
    html: fields.body.innerHTML.trim(),
    url: fields.url.value.trim(),
    path: fields.path.value.trim(),
    project: fields.project.value.trim(),
    actions: collectActions(fields.actionsHost),
    source: 'user',
  };
  const isoDate = fromLocalDateTime(fields.date.value);
  if (isoDate) {
    payload.date = isoDate;
  }
  if (!node && position) {
    payload.x = position.x;
    payload.y = position.y;
  }
  return payload;
}

function fieldInput(
  form: HTMLElement,
  label: string,
  value: string,
  type: string,
  listId?: string,
): HTMLInputElement {
  const wrapper = document.createElement('label');
  wrapper.className = 'ag-editor-field';
  const caption = document.createElement('span');
  caption.textContent = label;
  const input = document.createElement('input');
  input.type = type;
  input.value = value;
  if (listId) {
    input.setAttribute('list', listId);
  }
  wrapper.append(caption, input);
  form.appendChild(wrapper);
  return input;
}

interface Toolbar {
  element: HTMLElement;
  bind: (target: HTMLElement) => void;
}

function buildToolbar(): Toolbar {
  const bar = document.createElement('div');
  bar.className = 'ag-editor-toolbar';
  let target: HTMLElement | null = null;

  const commands: Array<{ label: string; title: string; run: () => void }> = [
    {
      label: 'B',
      title: t('actionGraphs.formatBold'),
      run: () => {
        exec('bold');
      },
    },
    {
      label: 'I',
      title: t('actionGraphs.formatItalic'),
      run: () => {
        exec('italic');
      },
    },
    {
      label: '••',
      title: t('actionGraphs.formatList'),
      run: () => {
        exec('insertUnorderedList');
      },
    },
    {
      label: '🔗',
      title: t('actionGraphs.formatLink'),
      run: () => {
        const href = linkInput.value.trim();
        if (href) {
          exec('createLink', href);
          linkInput.value = '';
        }
      },
    },
  ];

  function exec(command: string, value?: string): void {
    target?.focus();
    // execCommand is deprecated but remains the only dependency-free way to drive
    // contenteditable formatting; all target browsers keep supporting it.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    document.execCommand(command, false, value);
  }

  for (const command of commands) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = command.label;
    button.title = command.title;
    button.addEventListener('mousedown', (event) => {
      // Keep the contenteditable selection alive while clicking toolbar buttons.
      event.preventDefault();
    });
    button.addEventListener('click', command.run);
    bar.appendChild(button);
  }

  const linkInput = document.createElement('input');
  linkInput.type = 'text';
  linkInput.placeholder = 'https://…';
  linkInput.className = 'ag-editor-link-input';
  bar.appendChild(linkInput);

  return {
    element: bar,
    bind: (next) => {
      target = next;
    },
  };
}

function buildActionRow(action: ActionGraphNodeAction | null): HTMLElement {
  const row = document.createElement('div');
  row.className = 'ag-editor-action';

  const label = document.createElement('input');
  label.type = 'text';
  label.placeholder = t('actionGraphs.actionLabel');
  label.value = action?.label ?? '';
  label.dataset.field = 'label';

  const profile = document.createElement('select');
  profile.dataset.field = 'profile';
  for (const candidate of PROFILES) {
    const option = document.createElement('option');
    option.value = candidate;
    option.textContent = candidate;
    profile.appendChild(option);
  }
  profile.value =
    action?.profile && PROFILES.includes(action.profile) ? action.profile : 'terminal';

  const cwd = document.createElement('input');
  cwd.type = 'text';
  cwd.placeholder = t('actionGraphs.actionCwd');
  cwd.value = action?.cwd ?? '';
  cwd.dataset.field = 'cwd';

  const prompt = document.createElement('textarea');
  prompt.placeholder = t('actionGraphs.actionPrompt');
  prompt.value = action?.prompt ?? '';
  prompt.rows = 2;
  prompt.dataset.field = 'prompt';

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.textContent = '×';
  remove.title = t('actionGraphs.removeAction');
  remove.addEventListener('click', () => {
    row.remove();
  });

  row.append(label, profile, cwd, prompt, remove);
  return row;
}

function collectActions(host: HTMLElement): Omit<ActionGraphNodeAction, 'id'>[] {
  const actions: Omit<ActionGraphNodeAction, 'id'>[] = [];
  for (const row of host.querySelectorAll<HTMLElement>('.ag-editor-action')) {
    const label = row.querySelector<HTMLInputElement>('[data-field=label]')?.value.trim() ?? '';
    if (!label) {
      continue;
    }
    actions.push({
      label,
      profile: row.querySelector<HTMLSelectElement>('[data-field=profile]')?.value ?? 'terminal',
      cwd: row.querySelector<HTMLInputElement>('[data-field=cwd]')?.value.trim() ?? '',
      prompt: row.querySelector<HTMLTextAreaElement>('[data-field=prompt]')?.value.trim() ?? '',
    });
  }
  return actions;
}

function toLocalDateTime(value: string | null | undefined): string {
  if (!value) {
    return '';
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return '';
  }
  const pad = (part: number): string => String(part).padStart(2, '0');
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}T${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}

function fromLocalDateTime(value: string): string {
  if (!value.trim()) {
    return '';
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
}
