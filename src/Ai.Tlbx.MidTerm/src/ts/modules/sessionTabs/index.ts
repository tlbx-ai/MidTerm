/**
 * Session Tabs Module
 *
 * Provides per-session IDE-like tabs (Terminal | Files | Git | Commands)
 * above the terminal area. Only active in standalone mode.
 */

export {
  initSessionTabs,
  ensureSessionWrapper,
  destroySessionWrapper,
  getSessionWrapper,
  getTabPanel,
  getActiveTab,
  getTabBarHeight,
  setIdeModeEnabled,
  setSidebarTabActive,
  switchTab,
  reparentTerminalContainer,
  updateSessionCwd,
  onTabActivated,
  onTabDeactivated,
  onSidebarToggle,
} from './tabManager';
export type { SessionTabId } from './tabBar';
