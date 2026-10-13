import { t } from '../i18n';
import { type FileEditState } from './editState';
import {
  createLineNumberedEditor,
  createLineNumberedViewer,
  getExtension,
  getFileName,
  highlightCode,
  renderMarkdown,
  type LineNumberedEditorHandle,
  type LineNumberedViewerHandle,
} from './rendering';

export type DocumentViewMode = 'preview' | 'source' | 'edit';

export function getDocumentViewMode(container: HTMLElement): DocumentViewMode {
  const mode = container.querySelector<HTMLElement>('.file-document-view')?.dataset.fileMode;
  return mode === 'source' || mode === 'edit' ? mode : 'preview';
}

export function createTextView(options: {
  path: string;
  edit: FileEditState;
  readOnly: boolean;
  mode?: DocumentViewMode;
  save: () => Promise<void>;
}): { root: HTMLElement; setReadOnly: (readOnly: boolean) => void } {
  const { edit } = options;
  const extension = getExtension(options.path).toLowerCase();
  const markdown = extension === '.md' || extension === '.markdown';
  let readOnly = options.readOnly;
  let mode = options.mode ?? 'preview';
  let editor: LineNumberedEditorHandle | null = null;
  let source: LineNumberedViewerHandle | null = null;
  let article: HTMLElement | null = null;
  let displayedContent: string | null = null;
  let sourceContent: string | null = null;
  let editorPosition: { start: number; end: number; top: number; left: number } | null = null;
  const root = document.createElement('div');
  root.className = 'file-document-view';
  const controls = document.createElement('div');
  controls.className = 'file-document-modes';
  controls.setAttribute('role', 'group');
  controls.setAttribute('aria-label', t('fileViewer.displayMode'));
  const buttons = new Map<DocumentViewMode, HTMLButtonElement>();
  for (const value of (markdown
    ? ['preview', 'source', 'edit']
    : ['preview', 'edit']) as DocumentViewMode[]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'file-document-mode';
    button.dataset.mode = value;
    button.textContent = t(`fileViewer.mode${value.charAt(0).toUpperCase() + value.slice(1)}`);
    button.addEventListener('click', () => {
      if (mode === value) return;
      mode = value;
      render(true);
    });
    controls.append(button);
    buttons.set(value, button);
  }
  const status = document.createElement('span');
  status.className = 'file-document-mode-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  controls.append(status);
  root.append(controls);

  const syncState = (): void => {
    for (const [value, button] of buttons) {
      button.disabled = value === 'edit' && readOnly;
      button.setAttribute('aria-pressed', String(value === mode));
    }
    root.dataset.fileMode = mode;
    status.textContent = [
      readOnly ? t('fileViewer.readOnly') : '',
      edit.dirty ? t('fileViewer.unsavedTitle') : '',
    ]
      .filter(Boolean)
      .join(' · ');
  };
  const ensureSource = (): LineNumberedViewerHandle => {
    if (!source) {
      source = createLineNumberedViewer('', ['file-document-source']);
      source.root.tabIndex = 0;
      source.root.setAttribute('role', 'region');
      source.root.setAttribute('aria-label', t('fileViewer.modeSource'));
      root.append(source.root);
    }
    return source;
  };
  const ensureEditor = (): LineNumberedEditorHandle => {
    if (!editor) {
      editor = createLineNumberedEditor(edit.content, ['file-document-editor']);
      editor.textarea.setAttribute(
        'aria-label',
        `${t('fileViewer.modeEdit')}: ${getFileName(options.path)}`,
      );
      editor.textarea.addEventListener('input', () => {
        if (editor) edit.content = editor.textarea.value;
      });
      root.append(editor.root);
    }
    return editor;
  };
  const hideInactive = (): void => {
    if (editor) {
      const textarea = editor.textarea;
      if (!editor.root.hidden && mode !== 'edit')
        editorPosition = {
          start: textarea.selectionStart,
          end: textarea.selectionEnd,
          top: textarea.scrollTop,
          left: textarea.scrollLeft,
        };
      textarea.readOnly = readOnly;
      editor.root.hidden = mode !== 'edit';
    }
    if (source) source.root.hidden = mode === 'edit' || (mode === 'preview' && markdown);
    if (article) article.hidden = mode !== 'preview';
  };
  const render = (focus = false): void => {
    if (mode === 'edit' && readOnly) mode = 'preview';
    syncState();
    hideInactive();
    if (mode === 'edit') {
      const current = ensureEditor();
      current.root.hidden = false;
      if (focus) current.textarea.focus({ preventScroll: true });
      if (editorPosition) {
        current.textarea.setSelectionRange(editorPosition.start, editorPosition.end);
        current.textarea.scrollTop = editorPosition.top;
        current.textarea.scrollLeft = editorPosition.left;
      }
    } else if (mode === 'preview' && markdown) {
      if (!article) {
        article = document.createElement('article');
        article.className = 'file-document-markdown';
        article.tabIndex = 0;
        article.setAttribute('role', 'region');
        article.setAttribute('aria-label', t('fileViewer.modePreview'));
        root.append(article);
      }
      article.hidden = false;
      if (displayedContent !== edit.content) article.innerHTML = renderMarkdown(edit.content);
      displayedContent = edit.content;
    } else {
      const current = ensureSource();
      current.root.hidden = false;
      current.root.setAttribute(
        'aria-label',
        t(mode === 'source' ? 'fileViewer.modeSource' : 'fileViewer.modePreview'),
      );
      if (sourceContent !== edit.content)
        current.setText(edit.content, highlightCode(edit.content, extension));
      sourceContent = edit.content;
    }
  };
  edit.subscribe(() => {
    if (editor && editor.textarea.value !== edit.content) editor.setText(edit.content);
    if (mode === 'edit') syncState();
    else render();
  });
  const saveKey = (event: KeyboardEvent): void => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      event.stopPropagation();
      void options.save();
    }
  };
  root.addEventListener('keydown', saveKey);
  controls.addEventListener('keydown', saveKey);
  render();
  return {
    root,
    setReadOnly(value) {
      readOnly = value;
      render();
    },
  };
}
