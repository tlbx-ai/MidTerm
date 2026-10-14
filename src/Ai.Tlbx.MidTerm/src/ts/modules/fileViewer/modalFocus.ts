/** Focus lifetime for the file viewer; decision dialogs above it own their own focus. */
export function createFileViewerFocus(
  overlay: HTMLElement,
  escape: () => void,
  fallback: () => HTMLElement | null,
): {
  remember: (fromDock: boolean) => void;
  enter: () => void;
  restore: () => void;
} {
  const dialog = overlay.querySelector<HTMLElement>('[role="dialog"]');
  let previous: HTMLElement | null = null;
  const active = (): boolean =>
    !overlay.classList.contains('hidden') && !document.querySelector('.modal-overlay');
  const targets = (): HTMLElement[] =>
    [
      ...(dialog?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], iframe, [tabindex]:not([tabindex="-1"])',
      ) ?? []),
    ].filter(
      (element) =>
        element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden',
    );
  const enter = (): void => {
    (overlay.querySelector<HTMLElement>('.modal-close') ?? targets()[0] ?? dialog)?.focus({
      preventScroll: true,
    });
  };
  overlay.addEventListener('keydown', (event) => {
    if (!active()) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      escape();
    } else if (event.key === 'Tab') {
      const focusable = targets(),
        first = focusable[0],
        last = focusable[focusable.length - 1];
      if (
        !first ||
        (event.shiftKey && document.activeElement === first) ||
        (!event.shiftKey && document.activeElement === last) ||
        document.activeElement === dialog
      ) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      }
      event.stopPropagation();
    }
  });
  document.addEventListener('focusin', (event) => {
    if (active() && event.target instanceof Node && !overlay.contains(event.target)) enter();
  });
  return {
    remember(fromDock) {
      if (!fromDock && document.activeElement instanceof HTMLElement)
        previous = document.activeElement;
    },
    enter,
    restore() {
      const target =
        previous?.isConnected && previous !== document.body && previous.getClientRects().length > 0
          ? previous
          : fallback();
      target?.focus({ preventScroll: true });
      previous = null;
    },
  };
}
