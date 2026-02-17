/**
 * File Viewer Rendering Utilities
 *
 * Shared rendering functions, file type detection, and formatting helpers
 * used by both the file viewer and file browser modules.
 */

import { escapeHtml } from '../../utils';

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
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(1) + ' GB';
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

  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, _lang, code) => {
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
