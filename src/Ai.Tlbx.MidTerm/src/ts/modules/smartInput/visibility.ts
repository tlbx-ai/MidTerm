export interface SmartInputVisibilityState {
  activeSessionId: string | null | undefined;
  inputMode: string | null | undefined;
  lensActive: boolean;
}

export function shouldShowDockedSmartInput(state: SmartInputVisibilityState): boolean {
  if (!state.activeSessionId) {
    return false;
  }

  if (state.lensActive) {
    return true;
  }

  return state.inputMode === 'smartinput' || state.inputMode === 'both';
}

export function shouldShowLensQuickSettings(state: SmartInputVisibilityState): boolean {
  return Boolean(state.activeSessionId) && state.lensActive;
}
