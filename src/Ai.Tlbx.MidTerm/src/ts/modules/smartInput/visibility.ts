export interface SmartInputVisibilityState {
  activeSessionId: string | null | undefined;
  inputMode: string | null | undefined;
  appServerControlActive: boolean;
}

export function shouldShowDockedSmartInput(state: SmartInputVisibilityState): boolean {
  if (!state.activeSessionId) {
    return false;
  }

  if (state.appServerControlActive) {
    return true;
  }

  return state.inputMode === 'smartinput' || state.inputMode === 'both';
}

export function shouldShowAppServerControlQuickSettings(state: SmartInputVisibilityState): boolean {
  return Boolean(state.activeSessionId) && state.appServerControlActive;
}
