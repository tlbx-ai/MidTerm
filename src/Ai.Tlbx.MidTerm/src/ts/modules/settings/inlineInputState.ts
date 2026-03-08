/**
 * Settings Inline Input State
 *
 * Tracks the saved baseline for inline text/number settings so unsaved indicators
 * can be updated consistently across saves, rollbacks, and server sync.
 */

export function syncInlineTextInputWrappers(root: ParentNode): void {
  root.querySelectorAll('.text-input-wrapper').forEach((wrapper) => {
    if (!(wrapper instanceof HTMLElement)) {
      return;
    }

    const input = wrapper.querySelector('input[type="text"], input[type="number"]');
    if (!(input instanceof HTMLInputElement)) {
      return;
    }

    wrapper.dataset.savedValue = input.value;
    wrapper.classList.remove('unsaved');
  });
}

export function updateInlineTextInputWrapperState(input: HTMLInputElement): void {
  const wrapper = input.closest('.text-input-wrapper');
  if (!(wrapper instanceof HTMLElement)) {
    return;
  }

  const savedValue = wrapper.dataset.savedValue ?? input.value;
  wrapper.classList.toggle('unsaved', input.value !== savedValue);
}
