type TerminalGapFillerPlacement = 'right' | 'bottom' | 'corner';

const TERMINAL_GAP_FILLERS: TerminalGapFillerPlacement[] = ['right', 'bottom', 'corner'];

export function updateTerminalGapFillers(
  container: HTMLElement,
  xterm: HTMLElement,
  scale: number,
): void {
  const containerWidth = container.clientWidth;
  const containerHeight = container.clientHeight;
  const contentWidth = Math.min(containerWidth, Math.max(0, xterm.offsetWidth * scale));
  const contentHeight = Math.min(containerHeight, Math.max(0, xterm.offsetHeight * scale));
  const rightWidth = Math.max(0, containerWidth - contentWidth);
  const bottomHeight = Math.max(0, containerHeight - contentHeight);

  setTerminalGapVariable(container, '--terminal-gap-content-width', contentWidth);
  setTerminalGapVariable(container, '--terminal-gap-content-height', contentHeight);
  setTerminalGapVariable(container, '--terminal-gap-right-width', rightWidth);
  setTerminalGapVariable(container, '--terminal-gap-bottom-height', bottomHeight);

  if (rightWidth > 0 || bottomHeight > 0) {
    ensureTerminalGapFillers(container);
  }
}

export function clearTerminalGapFillers(container: HTMLElement): void {
  setTerminalGapVariable(container, '--terminal-gap-content-width', 0);
  setTerminalGapVariable(container, '--terminal-gap-content-height', 0);
  setTerminalGapVariable(container, '--terminal-gap-right-width', 0);
  setTerminalGapVariable(container, '--terminal-gap-bottom-height', 0);
}

function ensureTerminalGapFillers(container: HTMLElement): void {
  if (
    typeof document === 'undefined' ||
    !('createElement' in document) ||
    typeof container.appendChild !== 'function'
  ) {
    return;
  }

  for (const placement of TERMINAL_GAP_FILLERS) {
    const selector = `.terminal-gap-fill-${placement}`;
    if (container.querySelector(selector)) {
      continue;
    }

    const filler = document.createElement('div');
    filler.className = `terminal-gap-fill terminal-gap-fill-${placement}`;
    filler.setAttribute('aria-hidden', 'true');
    container.appendChild(filler);
  }
}

function setTerminalGapVariable(container: HTMLElement, name: string, value: number): void {
  const px = `${Math.round(value)}px`;
  if (typeof container.style.setProperty === 'function') {
    container.style.setProperty(name, px);
    return;
  }

  (container.style as CSSStyleDeclaration & Record<string, string>)[name] = px;
}
