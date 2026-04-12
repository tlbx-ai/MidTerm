/**
 * Smart Input Module
 *
 * Docked text input for Smart Input and Both modes.
 * Keeps terminal and text-entry behavior coordinated without
 * relying on direct terminal keyboard focus.
 */

export {
  initSmartInput,
  showSmartInput,
  hideSmartInput,
  isSmartInputMode,
  isBothMode,
  removeSmartInputSessionState,
  setLensResumeConversationHandler,
} from './smartInput';
export { startHistoryion, stopHistoryion } from './transcription';
