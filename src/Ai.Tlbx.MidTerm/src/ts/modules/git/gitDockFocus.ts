/** Focus ownership only for the small-screen Git overlay; desktop docks stay modeless. */
export function createGitDockFocus(
  dock: HTMLElement,
  close: () => void,
): {
  remember: () => void;
  enter: () => void;
  restore: () => void;
  refresh: () => void;
} {
  let previous: HTMLElement | null = null;
  const overlay = (): boolean =>
    !dock.classList.contains('hidden') && dock.dataset.gitOverlay === 'true';
  const ownsFocus = (): boolean =>
    overlay() && !document.querySelector('.modal-overlay, #file-viewer-modal:not(.hidden)');
  const targets = (): HTMLElement[] =>
    [
      ...dock.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ),
    ].filter(
      (element) =>
        element.tabIndex >= 0 &&
        element.getClientRects().length > 0 &&
        getComputedStyle(element).visibility !== 'hidden',
    );
  const enter = (): void => {
    (dock.querySelector<HTMLElement>('#git-dock-close') ?? targets()[0])?.focus({
      preventScroll: true,
    });
  };
  dock.addEventListener('keydown', (event) => {
    if (!ownsFocus() || event.defaultPrevented) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Tab') {
      const nodes = targets(),
        first = nodes[0],
        last = nodes[nodes.length - 1];
      if (
        !first ||
        (event.shiftKey && document.activeElement === first) ||
        (!event.shiftKey && document.activeElement === last)
      ) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus({ preventScroll: true });
      }
      event.stopPropagation();
    }
  });
  document.addEventListener('focusin', (event) => {
    if (ownsFocus() && event.target instanceof Node && !dock.contains(event.target)) enter();
  });
  return {
    remember() {
      if (document.activeElement instanceof HTMLElement && !dock.contains(document.activeElement))
        previous = document.activeElement;
    },
    enter() {
      if (ownsFocus()) enter();
    },
    restore() {
      const opener =
        previous?.isConnected && previous.getClientRects().length > 0
          ? previous
          : document.getElementById('btn-mobile-actions-menu');
      if (opener?.getClientRects().length) opener.focus({ preventScroll: true });
      previous = null;
    },
    refresh() {
      if (overlay()) {
        dock.setAttribute('role', 'dialog');
        dock.setAttribute('aria-modal', 'true');
      } else {
        dock.removeAttribute('role');
        dock.removeAttribute('aria-modal');
      }
      if (ownsFocus() && !dock.contains(document.activeElement)) enter();
    },
  };
}
