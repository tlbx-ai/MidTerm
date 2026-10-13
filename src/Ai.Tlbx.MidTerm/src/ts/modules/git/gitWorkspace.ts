import { t } from '../i18n';
import { escapeHtml as e } from '../../utils';
import { registerBackButtonLayer } from '../navigation/backButtonGuard';
import { gitOperationSummary } from './gitOperations';
import type {
  GitOperationRequest,
  GitOperationResponse,
  GitWorkspaceResponse,
  GitConflictView,
} from './types';

type Perform = (request: GitOperationRequest) => Promise<GitOperationResponse | null>;

function button(action: string, label: string, disabled = false): string {
  return `<button type="button" class="btn-secondary" data-workspace-action="${action}"${disabled ? ' disabled' : ''}>${e(t(label))}</button>`;
}
function field(name: string, label: string, contents: string, select = false): string {
  return `<label>${e(t(label))}${select ? `<select name="${name}">${contents}</select>` : `<input name="${name}" value="${e(contents)}" autocomplete="off">`}</label>`;
}
function options(values: Array<{ value: string; label: string }>, selected = ''): string {
  return values
    .map(
      ({ value, label }) =>
        `<option value="${e(value)}"${value === selected ? ' selected' : ''}>${e(label)}</option>`,
    )
    .join('');
}

function renderWorkspace(workspace: GitWorkspaceResponse): string {
  const blocked = workspace.mergeInProgress;
  const local = workspace.branches.filter((branch) => !branch.isRemote);
  const branches = options(
    local.map((branch) => ({ value: branch.name, label: branch.name })),
    workspace.currentBranch,
  );
  const mergeBranches = options(
    workspace.branches
      .filter((branch) => !branch.isCurrent)
      .map((branch) => ({ value: branch.ref, label: branch.name })),
  );
  const remotes = options([
    { value: '', label: t('git.selectRemote') },
    ...workspace.remotes.map((remote) => ({ value: remote.name, label: remote.name })),
  ]);
  return `<section class="git-workspace-section">
    <h4>${e(t('git.branches'))}</h4>
    ${field('branch', 'git.branch', branches, true)}<div class="git-workspace-actions">${button('branch-switch', 'git.switchBranch', blocked || local.length < 2)}</div>
    <details><summary>${e(t('git.createBranch'))}</summary>${field('newBranch', 'git.branchName', '')}${button('branch-create', 'git.createBranch', blocked)}</details>
  </section><section class="git-workspace-section">
    <h4>${e(t('git.remotes'))}</h4>
    ${workspace.remotes.length ? `${field('remote', 'git.remote', remotes, true)}${field('remoteBranch', 'git.targetBranch', workspace.currentBranch)}<div class="git-workspace-actions">${button('fetch', 'git.fetch', blocked)}${button('pull', 'git.pull', blocked)}${button('push', 'git.push', blocked)}</div>` : `<p>${e(t('git.noRemotes'))}</p>`}
    <details><summary>${e(t('git.merge'))}</summary>${field('mergeBranch', 'git.sourceBranch', mergeBranches, true)}${button('merge', 'git.merge', blocked || !mergeBranches)}</details>
  </section><section class="git-workspace-section">
    <h4>${e(t('git.stash'))}</h4>
    <details><summary>${e(t('git.stashCreate'))}</summary>${field('stashMessage', 'git.stashMessage', '')}${button('stash-create', 'git.stashCreate', blocked)}</details>
    ${workspace.stashes.map((stash) => `<div class="git-workspace-stash" data-stash-hash="${e(stash.hash)}"><span title="${e(stash.hash)}">${e(stash.ref)} · ${e(stash.message)}</span><time>${e(stash.date)}</time><div class="git-workspace-actions">${button('stash-apply', 'git.stashApply', blocked)}${button('stash-pop', 'git.stashPop', blocked)}${button('stash-drop', 'git.stashDrop', blocked)}</div></div>`).join('') || `<p>${e(t('git.noStashes'))}</p>`}
  </section>${workspace.mergeInProgress ? `<section class="git-workspace-section"><h4>${e(t('git.mergeInProgress'))}</h4><p>${e(t('git.mergeFinishHint'))}</p>${field('mergeMessage', 'git.commitMessage', workspace.mergeMessage)}<div class="git-workspace-actions">${button('commit', 'git.finishMerge')}${button('merge-abort', 'git.abortMerge')}</div></section>` : ''}`;
}

async function get<T>(
  sessionId: string,
  root: string,
  endpoint: string,
  path?: string,
): Promise<T> {
  const params = new URLSearchParams({ sessionId, repoRoot: root });
  if (path) params.set('path', path);
  const response = await fetch(`/api/git/${endpoint}?${params}`);
  if (!response.ok) {
    const result = (await response.json()) as { detail?: string };
    throw new Error(result.detail ?? t('git.readFailed'));
  }
  return (await response.json()) as T;
}

function request(
  sessionId: string,
  workspace: GitWorkspaceResponse,
  action: GitOperationRequest['action'],
): GitOperationRequest {
  return {
    sessionId,
    repoRoot: workspace.repoRoot,
    operationId: crypto.randomUUID(),
    action,
    paths: [],
    all: false,
    expectedHead: workspace.headHash,
    expectedBranch: workspace.currentBranch,
    expectedIndexVersion: workspace.indexVersion,
  };
}

/** Contextual repository actions use the same native operations and receipts as staging. */
export async function openGitWorkspace(
  sessionId: string,
  root: string,
  perform: Perform,
  conflictPath?: string,
): Promise<void> {
  const previous = document.activeElement;
  const dialog = document.createElement('dialog');
  dialog.className = 'git-workspace-dialog';
  dialog.innerHTML = `<header><h3 id="git-workspace-heading">${e(t(conflictPath ? 'git.resolveConflict' : 'git.workspace'))}</h3><button type="button" class="btn-secondary" data-close="true">${e(t('dialog.close'))}</button></header><p class="git-workspace-root">${e(root)}</p><div class="git-workspace-body"></div><p class="git-workspace-feedback" role="status" aria-live="polite">${e(t('git.loading'))}</p>`;
  dialog.setAttribute('aria-labelledby', 'git-workspace-heading');
  document.body.append(dialog);
  let workspace: GitWorkspaceResponse | null = null;
  let conflict: GitConflictView | null = null;
  let busy = false;
  const body = dialog.querySelector<HTMLElement>('.git-workspace-body');
  const feedback = dialog.querySelector<HTMLElement>('.git-workspace-feedback');
  const value = (name: string): string =>
    dialog.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`)?.value ?? '';
  const releaseBack = registerBackButtonLayer(() => {
    dialog.close();
  });
  dialog.addEventListener(
    'close',
    () => {
      releaseBack();
      dialog.remove();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true });
    },
    { once: true },
  );
  dialog.addEventListener('keydown', (event) => {
    event.stopPropagation();
  });
  dialog.showModal();
  dialog.querySelector<HTMLElement>('[data-close]')?.focus();
  const load = async (): Promise<void> => {
    try {
      workspace = await get<GitWorkspaceResponse>(sessionId, root, 'workspace');
      if (conflictPath)
        conflict = await get<GitConflictView>(sessionId, root, 'conflict', conflictPath);
      if (!dialog.isConnected || !body || !feedback) return;
      body.innerHTML = conflict ? renderConflict(conflict) : renderWorkspace(workspace);
      feedback.textContent = '';
    } catch (error) {
      if (feedback)
        feedback.textContent = error instanceof Error ? error.message : t('git.readFailed');
      if (body) body.innerHTML = button('refresh', 'git.retryStatus');
    }
  };
  dialog.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('button');
    if (target?.dataset.close) {
      dialog.close();
      return;
    }
    const action = target?.dataset.workspaceAction as
      GitOperationRequest['action'] | 'refresh' | 'edit' | undefined;
    if (!action || busy) return;
    if (action === 'refresh') {
      void load();
      return;
    }
    if (action === 'edit' && conflictPath) {
      dialog.close();
      void import('../fileViewer').then(async ({ openFile }) => {
        const { repositoryFilePath } = await import('../fileViewer/pathDetails');
        await openFile(repositoryFilePath(root, conflictPath));
      });
      return;
    }
    if (action === 'edit' || !workspace) return;
    const operation = buildWorkspaceRequest(sessionId, workspace, action, value, target, conflict);
    busy = true;
    void run(operation).finally(() => {
      busy = false;
    });
  });
  const run = async (operation: GitOperationRequest): Promise<void> => {
    if (operation.action === 'merge-abort' || operation.action === 'stash-drop') {
      const result = await confirmInDialog(
        dialog,
        t(operation.action === 'merge-abort' ? 'git.abortMergeConfirm' : 'git.stashDropConfirm'),
      );
      if (!result) return;
    }
    for (const control of dialog.querySelectorAll<
      HTMLInputElement | HTMLButtonElement | HTMLSelectElement
    >('input, select, button'))
      if (!control.dataset.close) control.disabled = true;
    if (feedback) feedback.textContent = t('git.operationBusy');
    const result = await perform(operation);
    await finishWorkspaceOperation(dialog, result, !!conflictPath, load);
  };
  await load();
}

function buildWorkspaceRequest(
  sessionId: string,
  workspace: GitWorkspaceResponse,
  action: GitOperationRequest['action'],
  value: (name: string) => string,
  target: HTMLElement | null,
  conflict: GitConflictView | null,
): GitOperationRequest {
  const operation = request(sessionId, workspace, action);
  const branchFields: Record<string, string> = {
    'branch-create': 'newBranch',
    merge: 'mergeBranch',
  };
  operation.branch = value(branchFields[action] ?? 'branch');
  operation.remote = value('remote');
  operation.remoteBranch = value('remoteBranch');
  operation.message = action === 'commit' ? value('mergeMessage') : value('stashMessage');
  const stashHash = target?.closest<HTMLElement>('[data-stash-hash]')?.dataset.stashHash;
  if (stashHash) operation.stashHash = stashHash;
  if (conflict) {
    operation.paths = [conflict.path];
    operation.expectedFileVersion = conflict.contentVersion;
    operation.resolution = target?.dataset.resolution ?? '';
  }
  return operation;
}

async function finishWorkspaceOperation(
  dialog: HTMLDialogElement,
  result: GitOperationResponse | null,
  isConflict: boolean,
  load: () => Promise<void>,
): Promise<void> {
  if (!dialog.isConnected) return;
  if (isConflict && result?.state === 'completed') {
    dialog.close();
    return;
  }
  if (!isConflict) await load();
  const feedback = dialog.querySelector<HTMLElement>('.git-workspace-feedback');
  if (feedback)
    feedback.textContent =
      gitOperationSummary(result) + (result?.detail ? '\n' + result.detail : '');
  const uncertain = !result || result.state === 'unknown';
  if (isConflict || uncertain)
    for (const control of dialog.querySelectorAll<HTMLButtonElement>('[data-workspace-action]'))
      control.disabled = uncertain;
}

function confirmInDialog(dialog: HTMLDialogElement, message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const confirmation = document.createElement('div');
    confirmation.className = 'git-workspace-confirm';
    confirmation.innerHTML = `<p>${e(message)}</p><button type="button" class="btn-secondary" data-confirm="false">${e(t('dialog.cancel'))}</button><button type="button" class="btn-danger" data-confirm="true">${e(t('dialog.confirm'))}</button>`;
    const closed = (): void => {
      confirmation.remove();
      resolve(false);
    };
    dialog.addEventListener('close', closed, { once: true });
    confirmation.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>('[data-confirm]');
      if (!target) return;
      dialog.removeEventListener('close', closed);
      confirmation.remove();
      resolve(target.dataset.confirm === 'true');
    });
    dialog.append(confirmation);
    confirmation.querySelector<HTMLButtonElement>('button')?.focus();
  });
}

function renderConflict(conflict: GitConflictView): string {
  return `<p class="git-workspace-conflict-path">${e(conflict.path)}</p>${conflict.isBinary ? `<p>${e(t('git.binaryConflict'))}</p>` : `<div class="git-conflict-versions"><details open><summary>${e(t('git.ours'))}</summary><pre>${e(conflict.hasOurs ? conflict.ours : t('git.deletedVersion'))}</pre></details><details open><summary>${e(t('git.theirs'))}</summary><pre>${e(conflict.hasTheirs ? conflict.theirs : t('git.deletedVersion'))}</pre></details><details><summary>${e(t('git.baseVersion'))}</summary><pre>${e(conflict.base)}</pre></details></div>`}${conflict.isTruncated ? `<p>${e(t('git.truncatedDiff'))}</p>` : ''}<div class="git-workspace-actions"><button class="btn-secondary" type="button" data-workspace-action="resolve-conflict" data-resolution="ours">${e(t('git.acceptOurs'))}</button><button class="btn-secondary" type="button" data-workspace-action="resolve-conflict" data-resolution="theirs">${e(t('git.acceptTheirs'))}</button>${button('edit', 'git.editConflict')}${button('refresh', 'git.retryStatus')}<button class="btn-primary" type="button" data-workspace-action="resolve-conflict" data-resolution="mark">${e(t('git.markResolved'))}</button></div>`;
}
