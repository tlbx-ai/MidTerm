const FOCUS_STEALING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

type MouseSelectionSnapshot = Pick<Selection, 'rangeCount' | 'isCollapsed'> | null | undefined;
type FocusTargetElement = {
  tagName: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => FocusTargetElement | null;
  parentElement?: FocusTargetElement | null;
};

function resolveSelection(): MouseSelectionSnapshot {
  if (typeof window === 'undefined' || typeof window.getSelection !== 'function') {
    return null;
  }

  return window.getSelection();
}

function hasNonCollapsedSelection(selection: MouseSelectionSnapshot): boolean {
  return !!selection && selection.rangeCount > 0 && !selection.isCollapsed;
}

function isFocusTargetElement(value: unknown): value is FocusTargetElement {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { tagName?: unknown }).tagName === 'string'
  );
}

function resolveTargetElement(target: EventTarget | null): FocusTargetElement | null {
  if (!target) {
    return null;
  }

  if (isFocusTargetElement(target)) {
    return target;
  }

  const parentElement = (target as { parentElement?: unknown }).parentElement;
  if (isFocusTargetElement(parentElement)) {
    return parentElement;
  }

  return null;
}

export function shouldReclaimTerminalFocusOnMouseUp(
  target: EventTarget | null,
  selection: MouseSelectionSnapshot = resolveSelection(),
): boolean {
  const element = resolveTargetElement(target);
  if (!element) {
    return !hasNonCollapsedSelection(selection);
  }

  if (
    FOCUS_STEALING_TAGS.has(element.tagName) ||
    element.isContentEditable === true ||
    element.closest?.('[contenteditable="true"]') != null
  ) {
    return false;
  }

  // Lens owns its own reading and keyboard interaction surface. Let text selection
  // and follow-up pointer interactions complete without forcing terminal focus back in.
  if (element.closest?.('.agent-view-panel') != null) {
    return false;
  }

  return !hasNonCollapsedSelection(selection);
}
