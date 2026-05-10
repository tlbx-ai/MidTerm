export interface SmartInputGlobalKeyBindingArgs {
  beginRecording(): void;
  canUseVoice(): boolean;
  closeFooterTransientUi(): boolean;
  endRecording(): void;
  getInterruptibleAppServerControlSessionId(): string | null;
  hasVisibleInput(): boolean;
  isRecording(): boolean;
  onAppServerControlEscape(sessionId: string): void;
}

export function bindSmartInputGlobalKeyBindings(args: SmartInputGlobalKeyBindingArgs): void {
  document.addEventListener(
    'keydown',
    (event) => {
      const appServerControlSessionId = args.getInterruptibleAppServerControlSessionId();
      if (!appServerControlSessionId) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      args.onAppServerControlEscape(appServerControlSessionId);
    },
    true,
  );

  document.addEventListener('keydown', (event) => {
    if (event.code === 'ControlRight') {
      if (!args.hasVisibleInput()) return;
      if (!args.canUseVoice()) return;
      if (args.isRecording()) return;
      event.preventDefault();
      args.beginRecording();
      return;
    }

    if (isBareEscapeKey(event) && args.closeFooterTransientUi()) {
      event.preventDefault();
    }
  });

  document.addEventListener('keyup', (event) => {
    if (event.code !== 'ControlRight') return;
    if (!args.isRecording()) return;
    event.preventDefault();
    args.endRecording();
  });
}

export function isBareEscapeKey(event: KeyboardEvent): boolean {
  return (
    event.key === 'Escape' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey
  );
}
