/**
 * Sidebar Collapse Module
 *
 * Handles sidebar visibility, collapse/expand state,
 * and island title updates for desktop view.
 */

import {
  sidebarOpen,
  setSidebarOpen,
  setSidebarCollapsed,
  dom
} from '../../state';
import { getCookie, setCookie } from '../../utils';
import { updateMobileTitle } from './sessionList';
import { rescaleAllTerminals } from '../terminal/scaling';

// =============================================================================
// Cookie Constants
// =============================================================================

const SIDEBAR_COLLAPSED_COOKIE = 'mm-sidebar-collapsed';
const SIDEBAR_WIDTH_COOKIE = 'mm-sidebar-width';
const DESKTOP_BREAKPOINT = 768;
const MIN_SIDEBAR_WIDTH = 180;
const MAX_SIDEBAR_WIDTH = 400;

// =============================================================================
// Mobile Sidebar Toggle
// =============================================================================

/**
 * Toggle mobile sidebar visibility
 */
export function toggleSidebar(): void {
  setSidebarOpen(!sidebarOpen);
  if (dom.app) dom.app.classList.toggle('sidebar-open', sidebarOpen);
}

/**
 * Close mobile sidebar
 */
export function closeSidebar(): void {
  setSidebarOpen(false);
  if (dom.app) dom.app.classList.remove('sidebar-open');
}

// =============================================================================
// Desktop Sidebar Collapse
// =============================================================================

/**
 * Collapse sidebar to icon-only mode (desktop)
 */
export function collapseSidebar(): void {
  setSidebarCollapsed(true);
  if (dom.app) dom.app.classList.add('sidebar-collapsed');
  setCookie(SIDEBAR_COLLAPSED_COOKIE, 'true');
  updateMobileTitle();
  requestAnimationFrame(rescaleAllTerminals);
}

/**
 * Expand sidebar to full width (desktop)
 */
export function expandSidebar(): void {
  setSidebarCollapsed(false);
  if (dom.app) dom.app.classList.remove('sidebar-collapsed');
  setCookie(SIDEBAR_COLLAPSED_COOKIE, 'false');
  requestAnimationFrame(rescaleAllTerminals);
}

// =============================================================================
// State Restoration
// =============================================================================

/**
 * Restore sidebar collapsed state from cookie (desktop only)
 */
export function restoreSidebarState(): void {
  if (getCookie(SIDEBAR_COLLAPSED_COOKIE) === 'true' && window.innerWidth > DESKTOP_BREAKPOINT) {
    setSidebarCollapsed(true);
    if (dom.app) dom.app.classList.add('sidebar-collapsed');
  }

  // Restore sidebar width
  const savedWidth = getCookie(SIDEBAR_WIDTH_COOKIE);
  if (savedWidth) {
    const width = parseInt(savedWidth, 10);
    if (width >= MIN_SIDEBAR_WIDTH && width <= MAX_SIDEBAR_WIDTH) {
      const sidebar = document.getElementById('sidebar');
      if (sidebar) {
        sidebar.style.width = width + 'px';
      }
    }
  }
}

// =============================================================================
// Sidebar Resize
// =============================================================================

/**
 * Set up sidebar resize grip functionality
 */
export function setupSidebarResize(): void {
  const grip = document.getElementById('sidebar-resize-grip');
  const sidebar = document.getElementById('sidebar');
  if (!grip || !sidebar) return;

  let isResizing = false;
  let startX = 0;
  let startWidth = 0;

  grip.addEventListener('mousedown', (e: MouseEvent) => {
    isResizing = true;
    startX = e.clientX;
    startWidth = sidebar.offsetWidth;
    grip.classList.add('active');
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e: MouseEvent) => {
    if (!isResizing) return;

    const delta = e.clientX - startX;
    const newWidth = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, startWidth + delta));
    sidebar.style.width = newWidth + 'px';
    rescaleAllTerminals();
  });

  document.addEventListener('mouseup', () => {
    if (!isResizing) return;

    isResizing = false;
    grip.classList.remove('active');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';

    // Save width to cookie
    const currentWidth = sidebar.offsetWidth;
    setCookie(SIDEBAR_WIDTH_COOKIE, String(currentWidth));
  });
}
