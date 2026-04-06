import {
  checkFilePaths,
  registerFilePaths,
  resolveFilePath,
  type FilePathInfo,
} from '../../api/client';
import {
  QUOTED_ABSOLUTE_PATH_PATTERN_GLOBAL,
  RELATIVE_PATH_PATTERN,
  UNC_PATH_PATTERN_GLOBAL,
  UNIX_PATH_PATTERN_GLOBAL,
  WIN_PATH_PATTERN_GLOBAL,
  isFragmentOfAbsolutePath,
  isLikelyUrlOrDomain,
  normalizePathCandidate,
  shouldRejectRelativeMatch,
} from '../terminal/fileRadar.patterns';
import type {
  AssistantImageCandidate,
  AssistantImagePreview,
  AssistantMarkdownCacheEntry,
  LensHistoryEntry,
  SessionLensViewState,
} from './types';

const IMAGE_EXTENSION_PATTERN = /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|tiff?|webp)$/i;
const BARE_URL_PATTERN = /(?:https?:\/\/|mailto:|www\.)[^\s<>"')\]]+/gi;
const GIT_HASH_PATTERN = /\b[0-9a-f]{7,40}\b/gi;
const NUMBER_PATTERN =
  /\b(?:v?\d+\.\d+(?:\.\d+){0,3}(?:-[a-z0-9.-]+)?|\d+(?:,\d{3})*(?:\.\d+)?(?:%|ms|s|m|h|kb|mb|gb|tb|px|ch)?|\d+\/\d+)\b/gi;
const TABLE_RULE_PATTERN = /[|+\-=:~\u2500-\u257f]/g;
const TRAILING_URL_PUNCTUATION = /[.,;!?]+$/;
const MAX_IMAGE_CANDIDATES = 6;

type InlineMatchKind = 'url' | 'file' | 'git' | 'number' | 'table_rule';

export interface AssistantInlineToken {
  kind: InlineMatchKind;
  start: number;
  end: number;
  text: string;
  href?: string;
  filePath?: string;
  filePathKind?: 'absolute' | 'relative';
  line?: number | null;
  column?: number | null;
  hash?: string;
}

interface HtmlBuildResult {
  html: string;
  imageCandidates: AssistantImageCandidate[];
}

interface HtmlElementFactory {
  createDocumentFragment(): DocumentFragment;
  createTextNode(data: string): Text;
  createElement<K extends keyof HTMLElementTagNameMap>(tagName: K): HTMLElementTagNameMap[K];
}

interface HtmlQueryRoot {
  querySelectorAll<E extends Element = Element>(selectors: string): NodeListOf<E>;
}

interface ResolvedFilePathData {
  resolvedPath?: string | null;
  isDirectory?: boolean | null;
  size?: number | null;
  mimeType?: string | null;
  modified?: string | null;
  isText?: boolean | null;
}

function isRootedPath(path: string): boolean {
  return /^[a-z]:[\\/]/i.test(path) || /^\\\\/.test(path) || path.startsWith('/');
}

function isImagePath(path: string): boolean {
  return IMAGE_EXTENSION_PATTERN.test(path);
}

function buildFilePreviewUrl(sessionId: string, path: string): string {
  return `/api/files/view?path=${encodeURIComponent(path)}&sessionId=${encodeURIComponent(sessionId)}`;
}

async function openAssistantFile(path: string, info: FilePathInfo): Promise<void> {
  const fileViewer = await import('../fileViewer');
  await fileViewer.openFile(path, info);
}

async function openAssistantGitCommit(sessionId: string, hash: string): Promise<void> {
  const gitDock = await import('../git/gitDock');
  await gitDock.openGitCommitDock(sessionId, hash);
}

function normalizeBareUrl(url: string): string {
  if (/^www\./i.test(url)) {
    return `https://${url}`;
  }

  return url;
}

function overlapsExistingMatch(
  matches: readonly AssistantInlineToken[],
  start: number,
  end: number,
): boolean {
  return matches.some((match) => start < match.end && end > match.start);
}

function addMatch(matches: AssistantInlineToken[], next: AssistantInlineToken): void {
  if (next.start >= next.end || overlapsExistingMatch(matches, next.start, next.end)) {
    return;
  }

  matches.push(next);
}

function parseLineInfoSuffix(
  source: string,
  offset: number,
): {
  suffix: string;
  line: number | null;
  column: number | null;
} {
  const remainder = source.slice(offset);
  const match = remainder.match(/^:(\d+)(?::(\d+))?/);
  if (!match) {
    return { suffix: '', line: null, column: null };
  }

  return {
    suffix: match[0],
    line: match[1] ? Number.parseInt(match[1], 10) || null : null,
    column: match[2] ? Number.parseInt(match[2], 10) || null : null,
  };
}

function createHtmlElementFactory(documentRef: Document): HtmlElementFactory {
  return documentRef as HtmlElementFactory;
}

function createHtmlQueryRoot(root: ParentNode): HtmlQueryRoot {
  return root as HtmlQueryRoot;
}

function queryAll<E extends Element = Element>(root: ParentNode, selectors: string): E[] {
  const queryRoot = createHtmlQueryRoot(root) as HtmlQueryRoot & {
    querySelectorAll?: HtmlQueryRoot['querySelectorAll'];
  };
  if (typeof queryRoot.querySelectorAll !== 'function') {
    return [];
  }

  return Array.from(queryRoot.querySelectorAll.call(root, selectors) as NodeListOf<E>);
}

function toResolvedFileInfo(data: ResolvedFilePathData): FilePathInfo {
  return {
    exists: true,
    isDirectory: data.isDirectory ?? false,
    size: data.size ?? null,
    mimeType: data.mimeType ?? '',
    modified: data.modified ?? null,
    isText: data.isText ?? false,
  };
}

function createRelativePathPatternGlobal(): RegExp {
  return new RegExp(RELATIVE_PATH_PATTERN.source, 'g');
}

function collectBareUrlMatches(text: string, matches: AssistantInlineToken[]): void {
  BARE_URL_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(BARE_URL_PATTERN)) {
    const raw = match[0];
    const start = match.index;
    if (start < 0 || !raw) {
      continue;
    }

    const trimmed = raw.replace(TRAILING_URL_PUNCTUATION, '');
    if (!trimmed) {
      continue;
    }

    addMatch(matches, {
      kind: 'url',
      start,
      end: start + trimmed.length,
      text: trimmed,
      href: normalizeBareUrl(trimmed),
    });
  }
}

function collectAbsolutePathMatches(
  text: string,
  pattern: RegExp,
  pathKind: 'absolute',
  matches: AssistantInlineToken[],
  imageCandidates: Map<string, AssistantImageCandidate>,
): void {
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const input = match.input;
    if (isFragmentOfAbsolutePath({ input, index: match.index })) {
      continue;
    }

    const matchedPath = match[1];
    const fullMatch = match[0];
    const start = match.index;
    if (!matchedPath || !fullMatch || start < 0) {
      continue;
    }

    const pathOffset = fullMatch.indexOf(matchedPath);
    if (pathOffset < 0) {
      continue;
    }

    const tokenStart = start + pathOffset;
    const tokenEnd = tokenStart + matchedPath.length;
    if (overlapsExistingMatch(matches, tokenStart, tokenEnd)) {
      continue;
    }

    const normalizedPath = normalizePathCandidate(matchedPath);
    if (!normalizedPath || isLikelyUrlOrDomain(normalizedPath)) {
      continue;
    }

    const lineInfo = parseLineInfoSuffix(text, tokenEnd);
    const displayText = matchedPath + lineInfo.suffix;
    addMatch(matches, {
      kind: 'file',
      start: tokenStart,
      end: tokenEnd + lineInfo.suffix.length,
      text: displayText,
      filePath: normalizedPath,
      filePathKind: pathKind,
      line: lineInfo.line,
      column: lineInfo.column,
    });

    if (isImagePath(normalizedPath)) {
      imageCandidates.set(`${pathKind}:${normalizedPath}`, {
        displayText,
        normalizedPath,
        pathKind,
        line: lineInfo.line,
        column: lineInfo.column,
      });
    }
  }
}

function collectRelativePathMatches(
  text: string,
  matches: AssistantInlineToken[],
  imageCandidates: Map<string, AssistantImageCandidate>,
): void {
  const pattern = createRelativePathPatternGlobal();
  for (const match of text.matchAll(pattern)) {
    const matchedPath = match[1];
    const fullMatch = match[0];
    const start = match.index;
    if (!matchedPath || !fullMatch || start < 0) {
      continue;
    }

    const pathOffset = fullMatch.indexOf(matchedPath);
    if (pathOffset < 0) {
      continue;
    }

    const tokenStart = start + pathOffset;
    const tokenEnd = tokenStart + matchedPath.length;
    if (overlapsExistingMatch(matches, tokenStart, tokenEnd)) {
      continue;
    }

    const normalizedPath = normalizePathCandidate(matchedPath);
    if (!normalizedPath || shouldRejectRelativeMatch(normalizedPath)) {
      continue;
    }

    const lineInfo = parseLineInfoSuffix(text, tokenEnd);
    const displayText = matchedPath + lineInfo.suffix;
    addMatch(matches, {
      kind: 'file',
      start: tokenStart,
      end: tokenEnd + lineInfo.suffix.length,
      text: displayText,
      filePath: normalizedPath,
      filePathKind: 'relative',
      line: lineInfo.line,
      column: lineInfo.column,
    });

    if (isImagePath(normalizedPath)) {
      imageCandidates.set(`relative:${normalizedPath}`, {
        displayText,
        normalizedPath,
        pathKind: 'relative',
        line: lineInfo.line,
        column: lineInfo.column,
      });
    }
  }
}

function collectGitHashMatches(text: string, matches: AssistantInlineToken[]): void {
  GIT_HASH_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(GIT_HASH_PATTERN)) {
    const hash = match[0];
    const start = match.index;
    if (!hash || start < 0) {
      continue;
    }

    addMatch(matches, {
      kind: 'git',
      start,
      end: start + hash.length,
      text: hash,
      hash,
    });
  }
}

function collectNumberMatches(text: string, matches: AssistantInlineToken[]): void {
  NUMBER_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(NUMBER_PATTERN)) {
    const value = match[0];
    const start = match.index;
    if (!value || start < 0) {
      continue;
    }

    addMatch(matches, {
      kind: 'number',
      start,
      end: start + value.length,
      text: value,
    });
  }
}

function isTableLikeSnippet(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }

  const pipeCount = (trimmed.match(/[|]/g) ?? []).length;
  const boxCount = (trimmed.match(/[\u2500-\u257f]/g) ?? []).length;
  if (pipeCount >= 2 || boxCount >= 2) {
    return true;
  }

  return /^[+\-|:=~\s]+$/.test(trimmed) && trimmed.length >= 3;
}

function collectTableRuleMatches(text: string, matches: AssistantInlineToken[]): void {
  if (!isTableLikeSnippet(text)) {
    return;
  }

  TABLE_RULE_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(TABLE_RULE_PATTERN)) {
    const symbol = match[0];
    const start = match.index;
    if (!symbol || start < 0) {
      continue;
    }

    addMatch(matches, {
      kind: 'table_rule',
      start,
      end: start + symbol.length,
      text: symbol,
    });
  }
}

function buildInlineMatches(
  text: string,
  imageCandidates: Map<string, AssistantImageCandidate>,
): AssistantInlineToken[] {
  const matches: AssistantInlineToken[] = [];
  collectBareUrlMatches(text, matches);
  collectAbsolutePathMatches(
    text,
    QUOTED_ABSOLUTE_PATH_PATTERN_GLOBAL,
    'absolute',
    matches,
    imageCandidates,
  );
  collectAbsolutePathMatches(text, UNC_PATH_PATTERN_GLOBAL, 'absolute', matches, imageCandidates);
  collectAbsolutePathMatches(text, WIN_PATH_PATTERN_GLOBAL, 'absolute', matches, imageCandidates);
  collectAbsolutePathMatches(text, UNIX_PATH_PATTERN_GLOBAL, 'absolute', matches, imageCandidates);
  collectRelativePathMatches(text, matches, imageCandidates);
  collectGitHashMatches(text, matches);
  collectNumberMatches(text, matches);
  collectTableRuleMatches(text, matches);
  return matches.sort((left, right) => left.start - right.start || left.end - right.end);
}

export function scanAssistantTextEnrichment(text: string): {
  tokens: AssistantInlineToken[];
  imageCandidates: AssistantImageCandidate[];
} {
  const imageCandidates = new Map<string, AssistantImageCandidate>();
  return {
    tokens: buildInlineMatches(text, imageCandidates),
    imageCandidates: [...imageCandidates.values()].slice(0, MAX_IMAGE_CANDIDATES),
  };
}

function shouldSkipTextNode(node: Text): boolean {
  const parent = node.parentElement;
  if (!parent) {
    return true;
  }

  if (!node.textContent || node.textContent.length === 0) {
    return true;
  }

  const disallowed = parent.closest('a, code, pre, table, thead, tbody, tr, th, td');
  return disallowed !== null;
}

function collectEligibleTextNodes(root: Node): Text[] {
  const textNodes: Text[] = [];
  const visit = (node: Node): void => {
    if (node.nodeType === 3) {
      const textNode = node as Text;
      if (!shouldSkipTextNode(textNode)) {
        textNodes.push(textNode);
      }
      return;
    }

    for (const child of Array.from(node.childNodes)) {
      visit(child);
    }
  };

  visit(root);
  return textNodes;
}

function buildReplacementFragment(
  documentRef: Document,
  text: string,
  imageCandidates: Map<string, AssistantImageCandidate>,
): DocumentFragment | null {
  const htmlFactory = createHtmlElementFactory(documentRef);
  const matches = buildInlineMatches(text, imageCandidates);
  if (matches.length === 0) {
    return null;
  }

  const fragment = htmlFactory.createDocumentFragment();
  let cursor = 0;
  for (const match of matches) {
    if (match.start > cursor) {
      fragment.append(htmlFactory.createTextNode(text.slice(cursor, match.start)));
    }

    switch (match.kind) {
      case 'url': {
        const link = htmlFactory.createElement('a');
        link.className = 'agent-history-inline-link agent-history-inline-url';
        link.href = match.href ?? match.text;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = match.text;
        fragment.append(link);
        break;
      }
      case 'file': {
        const link = htmlFactory.createElement('a');
        link.className = 'agent-history-inline-link agent-history-inline-file';
        link.href = '#';
        link.dataset.filePath = match.filePath ?? '';
        link.dataset.filePathKind = match.filePathKind ?? 'absolute';
        if (typeof match.line === 'number') {
          link.dataset.fileLine = String(match.line);
        }
        if (typeof match.column === 'number') {
          link.dataset.fileColumn = String(match.column);
        }
        link.textContent = match.text;
        fragment.append(link);
        break;
      }
      case 'git': {
        const link = htmlFactory.createElement('a');
        link.className = 'agent-history-inline-link agent-history-inline-git-hash';
        link.href = '#';
        link.dataset.gitHash = match.hash ?? match.text;
        link.textContent = match.text;
        fragment.append(link);
        break;
      }
      case 'number': {
        const span = htmlFactory.createElement('span');
        span.className = 'agent-history-inline-number';
        span.textContent = match.text;
        fragment.append(span);
        break;
      }
      case 'table_rule': {
        const span = htmlFactory.createElement('span');
        span.className = 'agent-history-inline-table-rule';
        span.textContent = match.text;
        fragment.append(span);
        break;
      }
    }

    cursor = match.end;
  }

  if (cursor < text.length) {
    fragment.append(htmlFactory.createTextNode(text.slice(cursor)));
  }

  return fragment;
}

export function buildAssistantEnrichedHtml(markdownHtml: string): HtmlBuildResult {
  const documentRef = document;
  const htmlFactory = createHtmlElementFactory(documentRef);
  const container = htmlFactory.createElement('div');
  container.innerHTML = markdownHtml;
  const imageCandidates = new Map<string, AssistantImageCandidate>();
  const textNodes = collectEligibleTextNodes(container);

  for (const textNode of textNodes) {
    const text = textNode.textContent;
    const replacement = buildReplacementFragment(documentRef, text, imageCandidates);
    if (replacement) {
      textNode.replaceWith(replacement);
    }
  }

  for (const link of queryAll<HTMLAnchorElement>(container, 'a[href]')) {
    if (!link.classList.contains('agent-history-inline-link')) {
      link.classList.add('agent-history-inline-link');
    }
  }

  return {
    html: container.innerHTML,
    imageCandidates: [...imageCandidates.values()].slice(0, MAX_IMAGE_CANDIDATES),
  };
}

async function ensureAbsoluteFileInfo(
  sessionId: string,
  path: string,
): Promise<FilePathInfo | null> {
  try {
    await registerFilePaths(sessionId, [path]);
    const { data } = await checkFilePaths([path], sessionId);
    if (!data?.results) {
      return null;
    }

    return data.results[path] ?? null;
  } catch {
    return null;
  }
}

async function resolveAssistantFileReference(
  sessionId: string,
  path: string,
  pathKind: 'absolute' | 'relative',
): Promise<{ resolvedPath: string; info: FilePathInfo } | null> {
  const normalizedPath = normalizePathCandidate(path);
  if (!normalizedPath) {
    return null;
  }

  if (pathKind === 'absolute' || isRootedPath(normalizedPath)) {
    const info = await ensureAbsoluteFileInfo(sessionId, normalizedPath);
    if (info?.exists) {
      return { resolvedPath: normalizedPath, info };
    }

    if (normalizedPath.startsWith('/')) {
      try {
        const { data } = await resolveFilePath(sessionId, normalizedPath.slice(1), true);
        if (data?.exists && data.resolvedPath) {
          return {
            resolvedPath: data.resolvedPath,
            info: toResolvedFileInfo(data),
          };
        }
      } catch {
        return null;
      }
    }

    return null;
  }

  try {
    const { data } = await resolveFilePath(sessionId, normalizedPath, true);
    if (!data?.exists || !data.resolvedPath) {
      return null;
    }

    return {
      resolvedPath: data.resolvedPath,
      info: toResolvedFileInfo(data),
    };
  } catch {
    return null;
  }
}

async function resolveImageCandidatePreview(
  sessionId: string,
  candidate: AssistantImageCandidate,
): Promise<AssistantImagePreview | null> {
  const resolved = await resolveAssistantFileReference(
    sessionId,
    candidate.normalizedPath,
    candidate.pathKind,
  );
  if (!resolved?.info.exists || resolved.info.isDirectory) {
    return null;
  }

  const mimeType = resolved.info.mimeType ?? '';
  if (!mimeType.startsWith('image/') && !isImagePath(resolved.resolvedPath)) {
    return null;
  }

  return {
    resolvedPath: resolved.resolvedPath,
    displayPath: candidate.displayText,
    mimeType: mimeType || null,
  };
}

export async function ensureAssistantImagePreviews(
  sessionId: string,
  entry: LensHistoryEntry,
  cache: AssistantMarkdownCacheEntry,
  state: SessionLensViewState,
  rerender: (sessionId: string) => void,
): Promise<void> {
  if (entry.live || cache.imagePreviewResolutionStarted || cache.imageCandidates.length === 0) {
    return;
  }

  cache.imagePreviewResolutionStarted = true;
  const previews = (
    await Promise.all(
      cache.imageCandidates.map((candidate) => resolveImageCandidatePreview(sessionId, candidate)),
    )
  ).filter((preview): preview is AssistantImagePreview => preview !== null);

  const currentCache = state.assistantMarkdownCache.get(entry.id);
  if (!currentCache || currentCache !== cache || currentCache.body !== entry.body) {
    return;
  }

  const nextToken = previews.map((preview) => preview.resolvedPath).join('|');
  const currentToken = currentCache.imagePreviews.map((preview) => preview.resolvedPath).join('|');
  if (nextToken === currentToken) {
    currentCache.imagePreviews = previews;
    return;
  }

  currentCache.imagePreviews = previews;
  rerender(sessionId);
}

export function wireAssistantInteractiveContent(container: HTMLElement, sessionId: string): void {
  for (const link of queryAll<HTMLAnchorElement>(container, 'a[data-file-path]')) {
    if (link.dataset.assistantLinkBound === 'true') {
      continue;
    }

    link.dataset.assistantLinkBound = 'true';
    link.addEventListener('click', (event) => {
      event.preventDefault();
      const filePath = link.dataset.filePath;
      const pathKind = link.dataset.filePathKind === 'relative' ? 'relative' : 'absolute';
      if (!filePath) {
        return;
      }

      void (async () => {
        const resolved = await resolveAssistantFileReference(sessionId, filePath, pathKind);
        if (!resolved?.info.exists) {
          return;
        }

        await openAssistantFile(resolved.resolvedPath, resolved.info);
      })();
    });
  }

  for (const link of queryAll<HTMLAnchorElement>(container, 'a[data-git-hash]')) {
    if (link.dataset.assistantLinkBound === 'true') {
      continue;
    }

    link.dataset.assistantLinkBound = 'true';
    link.addEventListener('click', (event) => {
      event.preventDefault();
      const hash = link.dataset.gitHash;
      if (!hash) {
        return;
      }

      void openAssistantGitCommit(sessionId, hash);
    });
  }
}

export function createAssistantImagePreviewBlock(
  documentRef: Document,
  sessionId: string,
  previews: readonly AssistantImagePreview[],
): HTMLElement | null {
  if (previews.length === 0) {
    return null;
  }

  const container = documentRef.createElement('div');
  container.className = 'agent-history-inline-previews';
  for (const preview of previews) {
    const button = documentRef.createElement('button');
    button.type = 'button';
    button.className = 'agent-history-inline-preview';
    button.title = preview.displayPath;
    button.addEventListener('click', () => {
      const info: FilePathInfo = {
        exists: true,
        isDirectory: false,
        size: null,
        mimeType: preview.mimeType ?? '',
        modified: null,
        isText: false,
      };
      void openAssistantFile(preview.resolvedPath, info);
    });

    const image = documentRef.createElement('img');
    image.className = 'agent-history-inline-preview-image';
    image.src = buildFilePreviewUrl(sessionId, preview.resolvedPath);
    image.loading = 'lazy';
    image.alt = preview.displayPath;
    button.appendChild(image);

    const caption = documentRef.createElement('span');
    caption.className = 'agent-history-inline-preview-caption';
    caption.textContent = preview.displayPath;
    button.appendChild(caption);

    container.appendChild(button);
  }

  return container;
}
