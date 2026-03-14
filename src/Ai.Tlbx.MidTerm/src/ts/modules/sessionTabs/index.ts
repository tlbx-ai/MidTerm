/**
 * Session Tabs Module
 *
 * Provides per-session IDE-like tabs (Terminal | Files)
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
  setActionButtonActive,
  updateGitIndicatorForSession,
  switchTab,
  reparentTerminalContainer,
  updateSessionCwd,
  onTabActivated,
  onTabDeactivated,
} from './tabManager';
export type { SessionTabId } from './tabBar';
export type { IdeBarActionId } from './tabBar';
export {
  setCommandsClickHandler,
  setGitClickHandler,
  setShareClickHandler,
  setWebClickHandler,
} from './tabBar';
