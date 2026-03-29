import { isDevMode } from '../modules/sidebar/voiceSection';
import { registerBackButtonLayer } from '../modules/navigation/backButtonGuard';

interface DevErrorDialogOptions {
  title: string;
  context?: string;
  error: unknown;
}

function normalizeError(error: unknown): { summary: string; detail: string } {
  if (error instanceof Error) {
    const detail = error.stack?.trim() || error.message || String(error);
    return {
      summary: error.message || error.name || 'Unknown error',
      detail,
    };
  }

  if (typeof error === 'string') {
    return {
      summary: error,
      detail: error,
    };
  }

  const serialized = JSON.stringify(error, null, 2);
  return {
    summary: serialized || String(error),
    detail: serialized || String(error),
  };
}

export function showDevErrorDialog(options: DevErrorDialogOptions): void {
  if (!isDevMode()) {
    return;
  }

  const { summary, detail } = normalizeError(options.error);
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  let releaseBackButtonLayer: (() => void) | null = null;
  overlay.innerHTML = `
    <div class="modal dev-error-modal" role="dialog" aria-modal="true" aria-labelledby="dev-error-title">
      <div class="modal-header">
        <h3 id="dev-error-title"></h3>
        <button type="button" class="modal-close" data-role="close">&times;</button>
      </div>
      <div class="modal-body dev-error-body">
        <p class="dev-error-summary"></p>
        <pre class="dev-error-detail"></pre>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn-primary" data-role="close">Close</button>
      </div>
    </div>
  `;

  const title = overlay.querySelector<HTMLHeadingElement>('#dev-error-title');
  const summaryEl = overlay.querySelector<HTMLParagraphElement>('.dev-error-summary');
  const detailEl = overlay.querySelector<HTMLPreElement>('.dev-error-detail');
  if (title) {
    title.textContent = options.title;
  }
  if (summaryEl) {
    summaryEl.textContent = options.context ? `${options.context}: ${summary}` : summary;
  }
  if (detailEl) {
    detailEl.textContent = options.context ? `${options.context}\n\n${detail}` : detail;
  }

  const close = (): void => {
    document.removeEventListener('keydown', onKeyDown);
    releaseBackButtonLayer?.();
    releaseBackButtonLayer = null;
    overlay.remove();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' || event.key === 'Enter') {
      event.preventDefault();
      close();
    }
  };

  overlay.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    if (target === overlay || target.closest('[data-role="close"]')) {
      close();
    }
  });

  document.addEventListener('keydown', onKeyDown);
  document.body.appendChild(overlay);
  releaseBackButtonLayer = registerBackButtonLayer(close);
  overlay.querySelector<HTMLButtonElement>('[data-role="close"]')?.focus();
}
