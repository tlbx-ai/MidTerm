import { icon } from '../../constants';
import { getTerminalSizeControl, hasTerminalSizeControl } from '../../stores';
import { requestTerminalSizeControl } from '../comms';
import { t } from '../i18n';
import { createLogger } from '../logging';
import type { TerminalPresentationActionState } from './terminalPresentation';

const log = createLogger('terminalSizeControl');
type FitOwnedTerminal = (sessionId: string, container: HTMLElement) => void;
type SetActionState = (actionState: TerminalPresentationActionState) => void;

export interface ScalingOverlayPresentation {
  ownsSize: boolean;
  hasOwner: boolean;
  ownerLabel: string | null;
  label: string;
  actionState: TerminalPresentationActionState;
}

export function createScalingOverlay(
  container: HTMLElement,
  fitOwnedTerminal: FitOwnedTerminal,
  setActionState: SetActionState,
): HTMLButtonElement {
  const overlay = document.createElement('button');
  overlay.className = 'scaled-overlay';
  overlay.type = 'button';
  overlay.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !event.isPrimary) return;

    // Claim before the terminal/session focus handlers can rebuild the follower UI.
    // The ensuing pointer-generated click is ignored below to avoid a second claim.
    event.preventDefault();
    event.stopPropagation();
    void handleScalingOverlayClick(container, fitOwnedTerminal, setActionState);
  });
  overlay.addEventListener('click', (event) => {
    event.stopPropagation();
    if (event.detail !== 0) {
      event.preventDefault();
      return;
    }

    // Keyboard activation and HTMLElement.click() do not emit pointerdown.
    void handleScalingOverlayClick(container, fitOwnedTerminal, setActionState);
  });
  container.appendChild(overlay);
  return overlay;
}

async function handleScalingOverlayClick(
  container: HTMLElement,
  fitOwnedTerminal: FitOwnedTerminal,
  setActionState: SetActionState,
): Promise<void> {
  const sessionId = getTerminalSessionId(container);
  if (!sessionId) return;
  if (hasTerminalSizeControl(sessionId)) {
    fitOwnedTerminal(sessionId, container);
    return;
  }

  setActionState('claiming');
  try {
    const expectedEpoch = getTerminalSizeControl(sessionId)?.epoch ?? 0;
    const result = await requestTerminalSizeControl(sessionId, true, expectedEpoch);
    if (result.status.isOwner) fitOwnedTerminal(sessionId, container);
  } catch (error: unknown) {
    log.warn(() => `Failed to claim terminal size control: ${String(error)}`);
  } finally {
    setActionState('idle');
  }
}

function getTerminalSessionId(container: HTMLElement): string | null {
  const prefix = 'terminal-';
  return container.id.startsWith(prefix) ? container.id.slice(prefix.length) || null : null;
}

export function positionScalingOverlay(
  overlay: HTMLButtonElement,
  presentation: ScalingOverlayPresentation,
): void {
  const { ownsSize, hasOwner, ownerLabel, label, actionState } = presentation;
  const title = ownsSize ? t('terminal.resizeToThisViewport') : t('terminal.continueHere');
  const followerTitle = hasOwner
    ? t('terminal.sizeControlledElsewhere')
    : t('terminal.sizeControlUnassigned');
  const ownerTransferHint = ownerLabel
    ? `${t('terminal.takeControlFrom')} ${escapeOwnerLabel(ownerLabel)}`
    : t('terminal.continueHereHint');
  overlay.title = title;
  overlay.setAttribute('aria-label', title);
  overlay.setAttribute('aria-hidden', ownsSize ? 'true' : 'false');
  overlay.setAttribute('aria-busy', actionState === 'claiming' ? 'true' : 'false');
  overlay.disabled = ownsSize || actionState === 'claiming';
  overlay.classList.remove('claiming');
  overlay.classList.remove('presentation-visible');
  overlay.classList.add(ownsSize ? 'presentation-hidden' : 'presentation-visible');
  if (!ownsSize) overlay.classList.remove('presentation-hidden');
  if (actionState === 'claiming') overlay.classList.add('claiming');
  overlay.innerHTML = ownsSize
    ? `${icon('resize')} <span>${label}</span>`
    : `${icon('resize')}<span class="scaled-overlay-copy"><strong>${followerTitle}</strong><span>${label}</span></span><span class="scaled-overlay-action"><strong>${actionState === 'claiming' ? t('terminal.switchingHere') : t('terminal.continueHere')}</strong><span>${ownerTransferHint}</span></span>`;

  const connectionBadgeVisible = isConnectionBadgeVisible();
  overlay.classList.remove('connection-status-offset');
  if (connectionBadgeVisible) {
    overlay.classList.add('connection-status-offset');
  }
}

function isConnectionBadgeVisible(): boolean {
  const badge = document.getElementById('connection-status');
  return ['disconnected', 'reconnecting', 'connecting'].some((name) =>
    badge?.classList.contains(name),
  );
}

function escapeOwnerLabel(label: string): string {
  return label
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
