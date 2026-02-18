/**
 * Git Diff Renderer & Floating Overlay
 *
 * Renders unified diff output with color coding.
 * Provides a draggable/resizable floating overlay for viewing diffs.
 */

import { escapeHtml } from '../../utils';
import { fetchDiff } from './gitApi';
import { t } from '../i18n';

const OVERLAY_STORAGE_KEY = 'mt-git-diff-rect';

let activeOverlay: { overlay: HTMLElement; path: string } | null = null;

export function renderDiff(diffText: string): string {
  if (!diffText.trim()) return '<div class="git-diff-empty">No changes</div>';

  const lines = diffText.split('\n');
  let html = '<div class="git-diff-view"><pre class="git-diff-content">';

  for (const line of lines) {
    const escaped = escapeHtml(line);
    if (line.startsWith('+++') || line.startsWith('---')) {
      html += `<span class="git-diff-header">${escaped}</span>\n`;
    } else if (line.startsWith('@@')) {
      html += `<span class="git-diff-hunk">${escaped}</span>\n`;
    } else if (line.startsWith('+')) {
      html += `<span class="git-diff-add">${escaped}</span>\n`;
    } else if (line.startsWith('-')) {
      html += `<span class="git-diff-del">${escaped}</span>\n`;
    } else {
      html += `${escaped}\n`;
    }
  }

  html += '</pre></div>';
  return html;
}

function loadOverlayRect(): { x: number; y: number; w: number; h: number } | null {
  try {
    const raw = localStorage.getItem(OVERLAY_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveOverlayRect(x: number, y: number, w: number, h: number): void {
  try {
    localStorage.setItem(OVERLAY_STORAGE_KEY, JSON.stringify({ x, y, w, h }));
  } catch {
    // localStorage full or unavailable
  }
}

export function closeDiffOverlay(): void {
  if (!activeOverlay) return;
  const rect = activeOverlay.overlay.getBoundingClientRect();
  saveOverlayRect(rect.left, rect.top, rect.width, rect.height);
  activeOverlay.overlay.remove();
  activeOverlay = null;
}

export async function openDiffOverlay(
  sessionId: string,
  path: string,
  staged: boolean,
): Promise<void> {
  if (activeOverlay?.path === path) {
    closeDiffOverlay();
    return;
  }
  closeDiffOverlay();

  const diff = await fetchDiff(sessionId, path, staged);
  const diffHtml = renderDiff(diff ?? '');

  const overlay = document.createElement('div');
  overlay.className = 'git-diff-overlay';

  const saved = loadOverlayRect();
  const x = saved?.x ?? Math.max(50, window.innerWidth - 700);
  const y = saved?.y ?? 60;
  const w = saved?.w ?? 640;
  const h = saved?.h ?? 480;

  overlay.style.left = `${x}px`;
  overlay.style.top = `${y}px`;
  overlay.style.width = `${w}px`;
  overlay.style.height = `${h}px`;

  const fileName = path.split('/').pop() ?? path;
  overlay.innerHTML = `
    <div class="git-diff-overlay-header">
      <span class="git-diff-overlay-title" title="${escapeHtml(path)}">${escapeHtml(fileName)}</span>
      <span class="git-diff-overlay-path">${escapeHtml(path)}</span>
      <button class="git-diff-overlay-close" title="${t('commands.close')}">&times;</button>
    </div>
    <div class="git-diff-overlay-body">${diffHtml}</div>`;

  document.body.appendChild(overlay);

  overlay.querySelector('.git-diff-overlay-close')?.addEventListener('click', closeDiffOverlay);

  setupDrag(overlay, overlay.querySelector('.git-diff-overlay-header') as HTMLElement);

  overlay.addEventListener('mouseup', () => {
    const rect = overlay.getBoundingClientRect();
    saveOverlayRect(rect.left, rect.top, rect.width, rect.height);
  });

  activeOverlay = { overlay, path };
}

function setupDrag(overlay: HTMLElement, handle: HTMLElement): void {
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;
  let dragging = false;

  const onMouseMove = (e: MouseEvent): void => {
    if (!dragging) return;
    overlay.style.left = `${startLeft + e.clientX - startX}px`;
    overlay.style.top = `${startTop + e.clientY - startY}px`;
  };

  const onMouseUp = (): void => {
    dragging = false;
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  };

  handle.addEventListener('mousedown', (e: MouseEvent) => {
    if ((e.target as HTMLElement).tagName === 'BUTTON') return;
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    const rect = overlay.getBoundingClientRect();
    startLeft = rect.left;
    startTop = rect.top;
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    e.preventDefault();
  });
}
