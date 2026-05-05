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
  getTabLabelForSession,
  isTabAvailable,
  getTabBarHeight,
  setActionButtonActive,
  updateGitIndicatorForSession,
  setSessionLensAvailability,
  switchTab,
  reparentTerminalContainer,
  updateSessionCwd,
  onTabActivated,
  onTabDeactivated,
  syncSessionTabCapabilities,
} from './tabManager';
export type { SessionTabId } from './tabBar';
export type { IdeBarActionId } from './tabBar';
export {
  isTabVisible,
  setCommandsClickHandler,
  setGitClickHandler,
  setGitRepoActionHandlers,
  setActionVisible,
  setShareClickHandler,
  setTabVisible,
  setWebClickHandler,
} from './tabBar';
