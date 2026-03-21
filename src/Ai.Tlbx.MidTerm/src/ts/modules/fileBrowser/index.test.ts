import { beforeEach, describe, expect, it, vi } from 'vitest';

const tabActivatedCallbacks = new Map<string, (sessionId: string, panel: HTMLDivElement) => void>();
const processListeners: Array<(sessionId: string, state: { foregroundCwd: string | null }) => void> = [];

const createTreeViewMock = vi.fn();
const setTreeRootMock = vi.fn();
const destroyTreeViewMock = vi.fn();
const renderPreviewMock = vi.fn();
const clearPreviewMock = vi.fn();

vi.mock('../logging', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    verbose: vi.fn(),
  }),
}));

vi.mock('../sessionTabs', () => ({
  onTabActivated: (tab: string, callback: (sessionId: string, panel: HTMLDivElement) => void) => {
    tabActivatedCallbacks.set(tab, callback);
  },
  onTabDeactivated: vi.fn(),
}));

vi.mock('../process', () => ({
  addProcessStateListener: (callback: (sessionId: string, state: { foregroundCwd: string | null }) => void) => {
    processListeners.push(callback);
    return () => {};
  },
}));

vi.mock('./treeView', () => ({
  createTreeView: createTreeViewMock,
  setTreeRoot: setTreeRootMock,
  destroyTreeView: destroyTreeViewMock,
}));

vi.mock('./filePreview', () => ({
  renderPreview: renderPreviewMock,
  clearPreview: clearPreviewMock,
}));

describe('fileBrowser', () => {
  beforeEach(async () => {
    tabActivatedCallbacks.clear();
    processListeners.length = 0;
    createTreeViewMock.mockReset();
    setTreeRootMock.mockReset();
    destroyTreeViewMock.mockReset();
    renderPreviewMock.mockReset();
    clearPreviewMock.mockReset();

    vi.resetModules();

    const stores = await import('../../stores');
    stores.$processStates.set({});
  });

  it('hydrates the tree immediately from existing process state when the Files tab opens', async () => {
    const stores = await import('../../stores');
    stores.$processStates.setKey('session-1', {
      foregroundPid: null,
      foregroundName: null,
      foregroundCommandLine: null,
      foregroundCwd: 'Q:\\repos\\MidTerm',
      foregroundDisplayName: null,
      foregroundProcessIdentity: null,
    });

    const { initFileBrowser } = await import('./index');
    initFileBrowser();

    const onFilesActivated = tabActivatedCallbacks.get('files');
    expect(onFilesActivated).toBeTypeOf('function');

    const treeContainer = {} as HTMLElement;
    const previewContainer = {} as HTMLElement;
    const panel = {
      querySelector: vi.fn((selector: string) => {
        if (selector === '.file-browser-tree') return treeContainer;
        if (selector === '.file-browser-preview') return previewContainer;
        return null;
      }),
    };

    onFilesActivated?.('session-1', panel as HTMLDivElement);

    expect(createTreeViewMock).toHaveBeenCalledWith(
      treeContainer,
      'session-1',
      expect.any(Function),
    );
    expect(clearPreviewMock).toHaveBeenCalledWith(previewContainer);
    expect(setTreeRootMock).toHaveBeenCalledWith('session-1', 'Q:\\repos\\MidTerm');
  });
});
