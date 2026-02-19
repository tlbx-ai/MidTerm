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
  setIdeModeEnabled,
  setActionButtonActive,
  updateAllGitIndicators,
  switchTab,
  reparentTerminalContainer,
  updateSessionCwd,
  onTabActivated,
  onTabDeactivated,
} from './tabManager';
export type { SessionTabId } from './tabBar';
export type { IdeBarActionId } from './tabBar';
export { setCommandsClickHandler, setGitClickHandler, setWebClickHandler } from './tabBar';
