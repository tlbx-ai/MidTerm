import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGitPanel,
  destroyGitPanel,
  renderGitPanelInto,
  suspendGitPanel,
  updateGitStatus,
  showCommitInGitPanel,
} from './gitPanel';
import { syncGitPanelDom } from './gitPanelDom';
import { fetchGitStatus, fetchCommitDetails } from './gitApi';
import type { GitStatusResponse } from './types';
import { $sessions } from '../../stores';
import { sessionTerminals } from '../../state';
import type { Session, TerminalState } from '../../types';

vi.mock('./gitPanelDom', () => ({ syncGitPanelDom: vi.fn() }));
vi.mock('./gitApi', () => ({
  fetchGitStatus: vi.fn(async () => null),
  fetchGitLog: vi.fn(),
  fetchDiffView: vi.fn(),
  fetchCommitDetails: vi.fn(),
}));
vi.mock('../terminal', () => ({ pasteToTerminal: vi.fn() }));
vi.mock('../i18n', () => ({ t: (key: string) => key }));

function container(): HTMLElement {
  return { querySelector: vi.fn(() => null), addEventListener: vi.fn() } as unknown as HTMLElement;
}

function status(branch: string): GitStatusResponse {
  return {
    branch,
    repoRoot: 'repo',
    ahead: 0,
    behind: 0,
    staged: [],
    modified: [],
    untracked: [],
    conflicted: [],
    recentCommits: [],
    stashCount: 0,
    totalAdditions: 0,
    totalDeletions: 0,
  };
}

describe('Git panel update ownership', () => {
  afterEach(() => {
    destroyGitPanel('a');
    destroyGitPanel('b');
    $sessions.set({});
    sessionTerminals.clear();
    vi.clearAllMocks();
  });

  it('blocks command insertion into an explicit controller even when its unused terminal state exists', async () => {
    const body = container(),
      inspector = container();
    body.querySelector = vi.fn((selector: string) =>
      selector === '.git-panel-inspector' ? inspector : null,
    ) as typeof body.querySelector;
    $sessions.set({ a: { id: 'a', isRunning: true, appServerControlOnly: true } as Session });
    sessionTerminals.set('a', {} as TerminalState);
    vi.mocked(fetchCommitDetails).mockResolvedValue({
      hash: 'abc',
      shortHash: 'abc',
      subject: 'Fixture',
      body: '',
      author: 'Author',
      authoredDate: '',
      committedDate: '',
      parentHashes: [],
      totalAdditions: 0,
      totalDeletions: 0,
      isTruncated: false,
      files: [],
    });
    createGitPanel(body, 'a', 'repo');
    updateGitStatus('a', status('main'));
    await showCommitInGitPanel('a', 'abc', 'repo');
    const html =
      vi
        .mocked(syncGitPanelDom)
        .mock.calls.filter((call) => call[0] === inspector)
        .at(-1)?.[1] ?? '';
    expect(html).toContain('data-action="insert-command"');
    expect(html).toMatch(/data-action="insert-command"[^>]+ disabled/);
    expect(html).not.toContain('send-command');
  });

  it('skips identical status and hidden rendering, then paints latest state on reopen', async () => {
    const body = container();
    createGitPanel(body, 'a', 'repo');
    updateGitStatus('a', status('dev'));
    vi.mocked(syncGitPanelDom).mockClear();
    updateGitStatus('a', status('dev'));
    expect(syncGitPanelDom).not.toHaveBeenCalled();
    suspendGitPanel(body);
    updateGitStatus('a', status('latest'));
    expect(syncGitPanelDom).not.toHaveBeenCalled();
    await renderGitPanelInto(body, 'a', 'repo');
    expect(syncGitPanelDom).toHaveBeenCalledWith(body, expect.stringContaining('latest'));
  });

  it('does not let a delayed fetch or background session overwrite the shared dock', async () => {
    const body = container();
    let resolveFetch!: (value: GitStatusResponse) => void;
    vi.mocked(fetchGitStatus).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const pending = renderGitPanelInto(body, 'a', 'repo');
    createGitPanel(body, 'b', 'repo');
    updateGitStatus('b', status('visible'));
    vi.mocked(syncGitPanelDom).mockClear();
    resolveFetch(status('late'));
    await pending;
    updateGitStatus('a', status('background'));
    expect(syncGitPanelDom).not.toHaveBeenCalled();
  });

  it('keeps pushed status when an older fetch finishes', async () => {
    const body = container();
    let resolveFetch!: (value: GitStatusResponse) => void;
    vi.mocked(fetchGitStatus).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const pending = renderGitPanelInto(body, 'a', 'repo');
    updateGitStatus('a', status('newer-push'));
    resolveFetch(status('old-fetch'));
    await pending;
    expect(syncGitPanelDom).toHaveBeenLastCalledWith(body, expect.stringContaining('newer-push'));
  });
});
