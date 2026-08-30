import { icon } from '../../constants';
import { getTerminalSizeControl, hasTerminalSizeControl } from '../../stores';
import { requestTerminalSizeControl } from '../comms';
import { t } from '../i18n';
import { createLogger } from '../logging';

const log = createLogger('terminalSizeControl');
type FitOwnedTerminal = (sessionId: string, container: HTMLElement) => void;

export function createScalingOverlay(
  container: HTMLElement,
  ownsSize: boolean,
  fitOwnedTerminal: FitOwnedTerminal,
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
    void handleScalingOverlayClick(overlay, container, fitOwnedTerminal);
  });
  overlay.addEventListener('click', (event) => {
    event.stopPropagation();
    if (event.detail !== 0) {
      event.preventDefault();
      return;
    }

    // Keyboard activation and HTMLElement.click() do not emit pointerdown.
    void handleScalingOverlayClick(overlay, container, fitOwnedTerminal);
  });
  container.appendChild(overlay);
  positionScalingOverlay(overlay, ownsSize, overlay.innerText);
  return overlay;
}

async function handleScalingOverlayClick(
  overlay: HTMLButtonElement,
  container: HTMLElement,
  fitOwnedTerminal: FitOwnedTerminal,
): Promise<void> {
  const sessionId = getTerminalSessionId(container);
  if (!sessionId) return;
  if (hasTerminalSizeControl(sessionId)) {
    fitOwnedTerminal(sessionId, container);
    return;
  }

  overlay.classList.add('claiming');
  overlay.disabled = true;
  try {
    const expectedEpoch = getTerminalSizeControl(sessionId)?.epoch ?? 0;
    const result = await requestTerminalSizeControl(sessionId, true, expectedEpoch);
    if (result.status.isOwner) fitOwnedTerminal(sessionId, container);
  } catch (error: unknown) {
    log.warn(() => `Failed to claim terminal size control: ${String(error)}`);
  } finally {
    overlay.classList.remove('claiming');
    overlay.disabled = false;
  }
}

function getTerminalSessionId(container: HTMLElement): string | null {
  const prefix = 'terminal-';
  return container.id.startsWith(prefix) ? container.id.slice(prefix.length) || null : null;
}

export function positionScalingOverlay(
  overlay: HTMLButtonElement,
  ownsSize: boolean,
  label: string,
): void {
  const title = ownsSize ? t('terminal.resizeToThisViewport') : t('terminal.continueHere');
  const sessionId = overlay.parentElement ? getTerminalSessionId(overlay.parentElement) : null;
  const ownership = sessionId ? getTerminalSizeControl(sessionId) : undefined;
  const followerTitle = ownership?.hasOwner
    ? t('terminal.sizeControlledElsewhere')
    : t('terminal.sizeControlUnassigned');
  const ownerTransferHint = ownership?.ownerLabel
    ? `${t('terminal.takeControlFrom')} ${escapeOwnerLabel(ownership.ownerLabel)}`
    : t('terminal.continueHereHint');
  overlay.title = title;
  overlay.setAttribute('aria-label', title);
  overlay.innerHTML = ownsSize
    ? `${icon('resize')} <span>${label}</span>`
    : `${icon('resize')}<span class="scaled-overlay-copy"><strong>${followerTitle}</strong><span>${label}</span></span><span class="scaled-overlay-action"><strong>${t('terminal.continueHere')}</strong><span>${ownerTransferHint}</span></span>`;

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
