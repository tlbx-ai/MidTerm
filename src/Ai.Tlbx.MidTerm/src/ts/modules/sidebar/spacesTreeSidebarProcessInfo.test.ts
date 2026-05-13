import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitRepoBinding, GitStatusResponse } from '../git/types';
import { syncSpacesTreeSidebarSessionProcessInfoElement } from './spacesTreeSidebarProcessInfo';

const mocks = vi.hoisted(() => ({
  repos: [] as GitRepoBinding[],
}));

class TestElement {
  className = '';
  dataset: Record<string, string> = {};
  textContent = '';
  title = '';
  private readonly children: TestElement[] = [];

  append(...children: TestElement[]): void {
    this.children.push(...children);
  }

  replaceChildren(...children: TestElement[]): void {
    this.children.length = 0;
    this.children.push(...children);
  }

  querySelector(selector: string): TestElement | null {
    const className = selector.startsWith('.') ? selector.slice(1) : selector;
    return this.findByClass(className);
  }

  private findByClass(className: string): TestElement | null {
    if (this.className.split(/\s+/).includes(className)) {
      return this;
    }

    for (const child of this.children) {
      const match = child.findByClass(className);
      if (match) {
        return match;
      }
    }

    return null;
  }
}

vi.mock('../git', () => ({
  getCachedGitReposForSession: () => mocks.repos,
}));

vi.mock('../process', () => ({
  getForegroundInfo: () => ({
    cwd: 'Q:/repos/Jpa',
    commandLine: 'codex --yolo',
    name: 'codex',
    displayName: 'codex --yolo',
  }),
}));

vi.mock('./sessionList', () => ({
  createForegroundIndicator: () => {
    const element = document.createElement('div') as unknown as TestElement;
    element.className = 'session-foreground';
    element.textContent = 'Q:/repos/Jpa > codex --yolo';
    return element;
  },
}));

function makeStatus(overrides: Partial<GitStatusResponse> = {}): GitStatusResponse {
  return {
    branch: 'dev',
    ahead: 0,
    behind: 0,
    staged: [],
    modified: [],
    untracked: [],
    conflicted: [],
    recentCommits: [],
    stashCount: 0,
    repoRoot: 'Q:\\repos\\MidTermWorkspace4',
    totalAdditions: 3,
    totalDeletions: 1,
    ...overrides,
  };
}

describe('spaces tree sidebar process info', () => {
  beforeEach(() => {
    mocks.repos.length = 0;
    vi.stubGlobal('document', {
      createElement: () => new TestElement(),
    });
  });

  it('shows extra monitored repositories by full directory path', () => {
    mocks.repos.push({
      repoRoot: 'Q:\\repos\\MidTermWorkspace4',
      label: 'MidTerm',
      role: 'target',
      source: 'manual',
      isPrimary: false,
      status: makeStatus(),
    });

    const processInfo = document.createElement('div') as unknown as HTMLElement;
    syncSpacesTreeSidebarSessionProcessInfoElement(processInfo, {
      id: 's1',
      session: {
        currentDirectory: 'Q:/repos/Jpa',
        workspacePath: 'Q:/repos/Jpa',
        shellType: 'pwsh',
      },
    });

    const repo = processInfo.querySelector<HTMLElement>('.session-extra-git-repo');
    expect(repo?.textContent).toBe('Q:\\repos\\MidTermWorkspace4');
  });
});
