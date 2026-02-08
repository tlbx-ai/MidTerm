import type { ScrollbarStyleSetting } from '../../api/types';

const SCROLLBAR_STYLE_CLASSES = ['scrollbar-off', 'scrollbar-hover', 'scrollbar-always'] as const;

type ScrollbarContainer = {
  classList: {
    remove: (...tokens: string[]) => void;
    add: (token: string) => void;
  };
};

export function isHoverCapable(): boolean {
  return window.matchMedia('(hover: hover) and (pointer: fine)').matches;
}

export function normalizeScrollbarStyle(value: string | null | undefined): ScrollbarStyleSetting {
  if (value === 'hover' || value === 'always') return value;
  return 'off';
}

export function resolveEffectiveScrollbarStyle(
  requestedStyle: ScrollbarStyleSetting,
  hoverCapable: boolean = isHoverCapable(),
): ScrollbarStyleSetting {
  if (requestedStyle === 'hover' && !hoverCapable) {
    return 'always';
  }
  return requestedStyle;
}

export function applyTerminalScrollbarStyleClass(
  container: ScrollbarContainer,
  requestedStyle: ScrollbarStyleSetting,
  hoverCapable: boolean = isHoverCapable(),
): ScrollbarStyleSetting {
  const effectiveStyle = resolveEffectiveScrollbarStyle(requestedStyle, hoverCapable);
  container.classList.remove(...SCROLLBAR_STYLE_CLASSES);
  container.classList.add(`scrollbar-${effectiveStyle}`);
  return effectiveStyle;
}
