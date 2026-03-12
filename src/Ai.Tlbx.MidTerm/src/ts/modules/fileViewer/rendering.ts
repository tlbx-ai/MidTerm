/**
 * File Viewer Rendering Utilities
 *
 * Shared rendering functions, file type detection, editor/viewer surface
 * creation, and formatting helpers used by both the file viewer and file
 * browser modules.
 */

import { $currentSettings } from '../../stores';
import { escapeHtml } from '../../utils';
import { buildTerminalFontStack } from '../terminal/fontConfig';
import { getEffectiveTerminalFontSize } from '../terminal/fontSize';

export const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.json',
  '.xml',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.js',
  '.ts',
  '.jsx',
  '.tsx',
  '.css',
  '.scss',
  '.less',
  '.html',
  '.htm',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.c',
  '.cpp',
  '.h',
  '.hpp',
  '.cs',
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.ps1',
  '.psm1',
  '.bat',
  '.cmd',
  '.sql',
  '.graphql',
  '.proto',
  '.csv',
  '.log',
  '.env',
  '.gitignore',
  '.dockerignore',
  '.editorconfig',
  '.eslintrc',
  '.prettierrc',
  'Makefile',
  'Dockerfile',
  'Vagrantfile',
  '.lua',
  '.dart',
  '.kt',
  '.swift',
  '.scala',
  '.clj',
  '.cljs',
  '.ex',
  '.exs',
  '.erl',
  '.hrl',
  '.r',
  '.R',
  '.m',
  '.mm',
  '.pl',
  '.pm',
  '.tcl',
  '.v',
  '.vh',
  '.sv',
  '.svh',
  '.vhd',
  '.vhdl',
  '.asm',
  '.s',
  '.S',
  '.f',
  '.f90',
  '.f95',
  '.for',
  '.cmake',
  '.make',
  '.mk',
  '.gradle',
  '.groovy',
  '.tf',
  '.hcl',
  '.nix',
  '.dhall',
  '.jsonc',
  '.json5',
  '.zig',
  '.nim',
  '.cr',
  '.jl',
  '.elm',
  '.purs',
  '.ml',
  '.mli',
  '.fs',
  '.fsi',
  '.fsx',
  '.vue',
  '.svelte',
]);

export const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp']);

export const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.avi']);

export const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.aac']);

export const IMAGE_MIMES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/bmp',
];

export const VIDEO_MIMES = ['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime'];
export const AUDIO_MIMES = ['audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/aac'];
export const PDF_MIME = 'application/pdf';

const DEFAULT_TERMINAL_FONT_SIZE = 14;
const DEFAULT_VIEWPORT_WIDTH = 1024;
const VIEWER_LINE_HEIGHT = 1.5;
const BINARY_BYTES_PER_LINE = 16;

export function getFileName(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || path;
}

export function getExtension(path: string): string {
  const name = getFileName(path);
  const dotIndex = name.lastIndexOf('.');
  return dotIndex >= 0 ? name.substring(dotIndex) : '';
}

export function joinPath(base: string, name: string): string {
  const sep = base.includes('\\') ? '\\' : '/';
  return base.endsWith(sep) ? base + name : base + sep + name;
}

export function getFileIcon(name: string, isDir?: boolean): string {
  if (isDir) return '📁';
  const ext = getExtension(name).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return '🖼️';
  if (VIDEO_EXTENSIONS.has(ext)) return '🎬';
  if (AUDIO_EXTENSIONS.has(ext)) return '🎵';
  if (ext === '.pdf') return '📕';
  if (['.zip', '.tar', '.gz', '.7z', '.rar'].includes(ext)) return '📦';
  if (['.js', '.ts', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.cs'].includes(ext)) return '📝';
  if (['.json', '.xml', '.yaml', '.yml', '.toml'].includes(ext)) return '⚙️';
  return '📄';
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function formatDate(isoDate: string): string {
  try {
    return new Date(isoDate).toLocaleString();
  } catch {
    return isoDate;
  }
}

export function isTextFile(ext: string, mime: string, serverIsText?: boolean | null): boolean {
  if (serverIsText != null) return serverIsText;
  if (TEXT_EXTENSIONS.has(ext)) return true;
  if (mime.startsWith('text/')) return true;
  if (mime === 'application/json' || mime === 'application/xml') return true;
  return false;
}

export function isImageFile(name: string, mime?: string): boolean {
  if (mime && IMAGE_MIMES.includes(mime)) return true;
  return IMAGE_EXTENSIONS.has(getExtension(name).toLowerCase());
}

export function isVideoFile(name: string, mime?: string): boolean {
  if (mime && VIDEO_MIMES.includes(mime)) return true;
  return VIDEO_EXTENSIONS.has(getExtension(name).toLowerCase());
}

export function isAudioFile(name: string, mime?: string): boolean {
  if (mime && AUDIO_MIMES.includes(mime)) return true;
  return AUDIO_EXTENSIONS.has(getExtension(name).toLowerCase());
}

export function buildViewUrl(path: string, sessionId: string): string {
  let url = `/api/files/view?path=${encodeURIComponent(path)}`;
  if (sessionId) {
    url += `&sessionId=${encodeURIComponent(sessionId)}`;
  }
  return url;
}

export function buildLineNumberText(lineCount: number): string {
  const safeLineCount = Math.max(lineCount, 1);
  const lines = new Array<string>(safeLineCount);
  for (let i = 0; i < safeLineCount; i++) {
    lines[i] = String(i + 1);
  }
  return lines.join('\n');
}

export function getLineCount(text: string): number {
  return Math.max(text.split('\n').length, 1);
}

export function formatBinaryDump(bytes: Uint8Array): string {
  if (bytes.length === 0) {
    return '';
  }

  const lines: string[] = [];

  for (let offset = 0; offset < bytes.length; offset += BINARY_BYTES_PER_LINE) {
    const chunk = bytes.slice(offset, offset + BINARY_BYTES_PER_LINE);
    const hex = Array.from(chunk, (value) => value.toString(16).toUpperCase().padStart(2, '0'))
      .join(' ')
      .padEnd(BINARY_BYTES_PER_LINE * 3 - 1, ' ');
    const ascii = Array.from(chunk, (value) =>
      value >= 0x20 && value <= 0x7e ? String.fromCharCode(value) : '.',
    ).join('');

    lines.push(`${offset.toString(16).toUpperCase().padStart(8, '0')}  ${hex}  ${ascii}`);
  }

  return lines.join('\n');
}

function getViewerFontMetrics(lineCount: number): {
  fontFamily: string;
  fontSizePx: number;
  gutterWidthCh: number;
} {
  const settings = $currentSettings.get();
  const viewportWidth = typeof window === 'undefined' ? DEFAULT_VIEWPORT_WIDTH : window.innerWidth;
  const fontSizePx = getEffectiveTerminalFontSize(
    settings?.fontSize ?? DEFAULT_TERMINAL_FONT_SIZE,
    viewportWidth,
  );

  return {
    fontFamily: buildTerminalFontStack(settings?.fontFamily),
    fontSizePx,
    gutterWidthCh: Math.max(String(Math.max(lineCount, 1)).length, 2),
  };
}

function applyViewerFontMetrics(container: HTMLElement, lineCount: number): void {
  const metrics = getViewerFontMetrics(lineCount);
  container.style.setProperty('--file-viewer-font-family', metrics.fontFamily);
  container.style.setProperty('--file-viewer-font-size', `${metrics.fontSizePx}px`);
  container.style.setProperty('--file-viewer-line-height', String(VIEWER_LINE_HEIGHT));
  container.style.setProperty('--file-viewer-gutter-width', `${metrics.gutterWidthCh}ch`);
}

export interface LineNumberedEditorHandle {
  root: HTMLDivElement;
  textarea: HTMLTextAreaElement;
  setText: (text: string) => void;
}

export interface LineNumberedViewerHandle {
  root: HTMLDivElement;
  pre: HTMLPreElement;
  setText: (text: string, html?: string) => void;
}

export function createLineNumberedEditor(
  initialText: string,
  extraClassNames: string[] = [],
): LineNumberedEditorHandle {
  const root = document.createElement('div');
  root.className = ['file-viewer-editor-shell', ...extraClassNames].join(' ');

  const gutter = document.createElement('div');
  gutter.className = 'file-viewer-line-gutter';
  gutter.setAttribute('aria-hidden', 'true');

  const numbers = document.createElement('pre');
  numbers.className = 'file-viewer-line-numbers';
  gutter.appendChild(numbers);

  const textarea = document.createElement('textarea');
  textarea.className = 'file-viewer-textarea';
  textarea.wrap = 'off';
  textarea.spellcheck = false;

  const updateMetrics = (text: string): void => {
    const lineCount = getLineCount(text);
    applyViewerFontMetrics(root, lineCount);
    numbers.textContent = buildLineNumberText(lineCount);
    gutter.scrollTop = textarea.scrollTop;
  };

  textarea.addEventListener('input', () => {
    updateMetrics(textarea.value);
  });
  textarea.addEventListener('scroll', () => {
    gutter.scrollTop = textarea.scrollTop;
  });

  const setText = (text: string): void => {
    textarea.value = text;
    updateMetrics(text);
  };

  setText(initialText);

  root.appendChild(gutter);
  root.appendChild(textarea);

  return { root, textarea, setText };
}

export function createLineNumberedViewer(
  text: string,
  extraClassNames: string[] = [],
  html?: string,
): LineNumberedViewerHandle {
  const root = document.createElement('div');
  root.className = ['file-viewer-readonly-shell', ...extraClassNames].join(' ');

  const gutter = document.createElement('div');
  gutter.className = 'file-viewer-line-gutter';
  gutter.setAttribute('aria-hidden', 'true');

  const numbers = document.createElement('pre');
  numbers.className = 'file-viewer-line-numbers';
  gutter.appendChild(numbers);

  const scroller = document.createElement('div');
  scroller.className = 'file-viewer-text-scroller';

  const pre = document.createElement('pre');
  pre.className = 'file-viewer-text';
  scroller.appendChild(pre);

  const setText = (nextText: string, nextHtml?: string): void => {
    const lineCount = getLineCount(nextText);
    applyViewerFontMetrics(root, lineCount);
    numbers.textContent = buildLineNumberText(lineCount);
    if (nextHtml !== undefined) {
      pre.innerHTML = nextHtml;
    } else {
      pre.textContent = nextText;
    }
    gutter.scrollTop = scroller.scrollTop;
  };

  scroller.addEventListener('scroll', () => {
    gutter.scrollTop = scroller.scrollTop;
  });

  setText(text, html);

  root.appendChild(gutter);
  root.appendChild(scroller);

  return { root, pre, setText };
}

// Universal syntax highlighting

const UNIVERSAL_KEYWORDS = [
  'if',
  'else',
  'elif',
  'for',
  'foreach',
  'while',
  'do',
  'switch',
  'case',
  'default',
  'break',
  'continue',
  'return',
  'goto',
  'throw',
  'try',
  'catch',
  'except',
  'finally',
  'with',
  'match',
  'when',
  'then',
  'fi',
  'done',
  'esac',
  'function',
  'func',
  'fn',
  'def',
  'sub',
  'proc',
  'method',
  'lambda',
  'class',
  'struct',
  'interface',
  'trait',
  'impl',
  'enum',
  'union',
  'type',
  'typedef',
  'const',
  'let',
  'var',
  'mut',
  'val',
  'final',
  'public',
  'private',
  'protected',
  'internal',
  'static',
  'readonly',
  'abstract',
  'virtual',
  'async',
  'await',
  'yield',
  'defer',
  'go',
  'import',
  'export',
  'from',
  'use',
  'using',
  'require',
  'include',
  'package',
  'module',
  'namespace',
  'mod',
  'crate',
  'extern',
  'new',
  'delete',
  'extends',
  'implements',
  'override',
  'true',
  'false',
  'True',
  'False',
  'null',
  'nil',
  'None',
  'undefined',
  'void',
  'this',
  'self',
  'super',
  'base',
  'and',
  'or',
  'not',
  'in',
  'is',
  'as',
  'typeof',
  'instanceof',
  'sizeof',
  'exit',
  'local',
  'select',
  'chan',
  'map',
  'range',
  'move',
  'pass',
  'pub',
];

const RE_KEYWORDS = new RegExp(`\\b(${UNIVERSAL_KEYWORDS.join('|')})\\b`, 'g');

const RE_COMMENT_SLASH = /(\/\/.*$)/gm;
const RE_COMMENT_HASH = /(#(?![[(]).*$)/gm;
const RE_COMMENT_DASHDASH = /(--.*$)/gm;
const RE_STRING_DOUBLE = /(&quot;[^&]*&quot;)/g;
const RE_STRING_SINGLE = /(&#39;[^&]*&#39;)/g;
const RE_STRING_TEMPLATE = /(`[^`]*`)/g;
const RE_NUMBER = /\b(0x[0-9a-fA-F_]+|0b[01_]+|0o[0-7_]+|\d[\d_]*\.?[\d_]*(?:[eE][+-]?\d+)?)\b/g;
const RE_TYPE = /\b([A-Z][a-z]+[A-Za-z0-9]*)\b(?!\s*\()/g;
const RE_FUNCTION_CALL = /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*(?=\()/g;

export function highlightCode(text: string, _ext: string): string {
  let escaped = escapeHtml(text);

  RE_COMMENT_SLASH.lastIndex = 0;
  RE_COMMENT_HASH.lastIndex = 0;
  RE_COMMENT_DASHDASH.lastIndex = 0;
  RE_STRING_DOUBLE.lastIndex = 0;
  RE_STRING_SINGLE.lastIndex = 0;
  RE_STRING_TEMPLATE.lastIndex = 0;
  RE_NUMBER.lastIndex = 0;
  RE_KEYWORDS.lastIndex = 0;
  RE_TYPE.lastIndex = 0;
  RE_FUNCTION_CALL.lastIndex = 0;

  escaped = escaped.replace(RE_COMMENT_SLASH, '<span class="hl-comment">$1</span>');
  escaped = escaped.replace(RE_COMMENT_HASH, '<span class="hl-comment">$1</span>');
  escaped = escaped.replace(RE_COMMENT_DASHDASH, '<span class="hl-comment">$1</span>');

  escaped = escaped.replace(RE_STRING_DOUBLE, '<span class="hl-string">$1</span>');
  escaped = escaped.replace(RE_STRING_SINGLE, '<span class="hl-string">$1</span>');
  escaped = escaped.replace(RE_STRING_TEMPLATE, '<span class="hl-string">$1</span>');

  escaped = escaped.replace(RE_NUMBER, '<span class="hl-number">$1</span>');
  escaped = escaped.replace(RE_KEYWORDS, '<span class="hl-keyword">$1</span>');
  escaped = escaped.replace(RE_TYPE, '<span class="hl-type">$1</span>');
  escaped = escaped.replace(RE_FUNCTION_CALL, '<span class="hl-function">$1</span>');

  return escaped;
}

export function renderMarkdown(text: string): string {
  let html = escapeHtml(text);

  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_match: string, _lang: string, code: string) => {
    return `<pre><code>${code.trim()}</code></pre>`;
  });

  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  html = html.replace(/_([^_]+)_/g, '<em>$1</em>');

  html = html.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>',
  );

  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

  html = html.replace(/^---$/gm, '<hr>');
  html = html.replace(/^\*\*\*$/gm, '<hr>');

  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

  html = html.replace(/^(?!<[hluopb]|<\/|<hr|<code|<blockquote)(.+)$/gm, '<p>$1</p>');

  html = html.replace(/<\/blockquote>\n<blockquote>/g, '\n');

  html = html.replace(/<p><\/p>/g, '');

  return html;
}
