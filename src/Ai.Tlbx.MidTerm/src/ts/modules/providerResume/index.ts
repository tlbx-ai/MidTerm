import { getProviderResumeCandidates } from '../../api/client';
import type { ProviderResumeCatalogEntryDto } from '../../api/types';
import { escapeHtml } from '../../utils/dom';
import { registerBackButtonLayer } from '../navigation/backButtonGuard';

export type ResumeProvider = 'codex' | 'claude';
export type ProviderResumeScope = 'current' | 'all';

export interface OpenProviderResumePickerOptions {
  provider: ResumeProvider;
  workingDirectory?: string | null;
  initialScope?: ProviderResumeScope;
}

let activeResumePickerPromise: Promise<ProviderResumeCatalogEntryDto | null> | null = null;

export async function openProviderResumePicker(
  options: OpenProviderResumePickerOptions,
): Promise<ProviderResumeCatalogEntryDto | null> {
  if (activeResumePickerPromise) {
    return activeResumePickerPromise;
  }

  activeResumePickerPromise = openProviderResumePickerInternal(options);
  try {
    return await activeResumePickerPromise;
  } finally {
    activeResumePickerPromise = null;
  }
}

async function openProviderResumePickerInternal(
  options: OpenProviderResumePickerOptions,
): Promise<ProviderResumeCatalogEntryDto | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay provider-resume-picker-overlay';
    let releaseBackButtonLayer: (() => void) | null = null;

    overlay.innerHTML = `
      <div class="modal provider-resume-picker-modal" role="dialog" aria-modal="true" aria-labelledby="provider-resume-picker-title">
        <div class="modal-content provider-resume-picker-content">
          <div class="modal-header">
            <div>
              <div class="provider-resume-picker-kicker">${escapeHtml(getProviderLabel(options.provider))}</div>
              <h3 id="provider-resume-picker-title">Resume Conversation</h3>
            </div>
            <button class="modal-close" type="button" data-role="cancel" aria-label="Cancel">&times;</button>
          </div>
          <div class="modal-body provider-resume-picker-body">
            <div class="provider-resume-picker-toolbar">
              <div class="provider-resume-picker-scope" data-role="scope">
                <button type="button" class="provider-resume-picker-scope-btn" data-scope="current">This folder</button>
                <button type="button" class="provider-resume-picker-scope-btn" data-scope="all">All</button>
              </div>
              <button type="button" class="btn-secondary provider-resume-picker-refresh" data-role="refresh">Refresh</button>
            </div>
            <div class="provider-resume-picker-status" data-role="status" hidden></div>
            <div class="provider-resume-picker-list" data-role="list"></div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn-secondary" data-role="cancel">Cancel</button>
          </div>
        </div>
      </div>
    `;

    const statusEl = overlay.querySelector<HTMLElement>('[data-role="status"]');
    const listEl = overlay.querySelector<HTMLElement>('[data-role="list"]');
    const scopeEl = overlay.querySelector<HTMLElement>('[data-role="scope"]');
    const refreshButton = overlay.querySelector<HTMLButtonElement>('[data-role="refresh"]');
    const cancelButtons = overlay.querySelectorAll<HTMLElement>('[data-role="cancel"]');
    if (!statusEl || !listEl || !scopeEl || !refreshButton) {
      overlay.remove();
      resolve(null);
      return;
    }

    const safeStatusEl = statusEl;
    const safeListEl = listEl;
    const safeScopeEl = scopeEl;
    const safeRefreshButton = refreshButton;

    let loading = false;
    let errorMessage: string | null = null;
    let entries: ProviderResumeCatalogEntryDto[] = [];
    let activeScope: ProviderResumeScope =
      options.initialScope ?? (options.workingDirectory?.trim() ? 'current' : 'all');
    let requestToken = 0;

    function close(result: ProviderResumeCatalogEntryDto | null): void {
      document.removeEventListener('keydown', onKeyDown);
      releaseBackButtonLayer?.();
      overlay.remove();
      resolve(result);
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') {
        return;
      }

      event.preventDefault();
      close(null);
    }

    function render(): void {
      safeStatusEl.hidden = !(loading || errorMessage);
      safeStatusEl.classList.toggle('error', Boolean(errorMessage));
      safeStatusEl.textContent = loading ? 'Loading conversations...' : (errorMessage ?? '');

      for (const button of safeScopeEl.querySelectorAll<HTMLElement>('[data-scope]')) {
        const isActive = button.dataset.scope === activeScope;
        button.classList.toggle('active', isActive);
        button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      }

      if (entries.length === 0) {
        safeListEl.innerHTML = `<div class="provider-resume-picker-empty">${
          loading ? 'Loading...' : 'No resumable conversations found.'
        }</div>`;
        return;
      }

      safeListEl.innerHTML = entries
        .map((entry) => {
          const subtitle = entry.previewText?.trim() || entry.workingDirectory;
          return `
            <button
              type="button"
              class="provider-resume-picker-row"
              data-session-id="${escapeHtml(entry.sessionId)}"
            >
              <span class="provider-resume-picker-row-head">
                <span class="provider-resume-picker-row-title">${escapeHtml(entry.title)}</span>
                <span class="provider-resume-picker-row-time">${escapeHtml(formatUpdatedAt(entry.updatedAtUtc))}</span>
              </span>
              <span class="provider-resume-picker-row-preview">${escapeHtml(subtitle)}</span>
              <span class="provider-resume-picker-row-path">${escapeHtml(entry.workingDirectory)}</span>
            </button>
          `;
        })
        .join('');
    }

    async function loadEntries(): Promise<void> {
      const currentToken = ++requestToken;
      loading = true;
      errorMessage = null;
      render();

      try {
        const nextEntries = await getProviderResumeCandidates(options.provider, {
          workingDirectory: options.workingDirectory ?? null,
          scope: activeScope,
        });
        if (currentToken !== requestToken) {
          return;
        }

        entries = nextEntries;
      } catch (error) {
        if (currentToken !== requestToken) {
          return;
        }

        entries = [];
        errorMessage = error instanceof Error ? error.message : String(error);
      } finally {
        if (currentToken === requestToken) {
          loading = false;
          render();
        }
      }
    }

    render();
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKeyDown);
    releaseBackButtonLayer = registerBackButtonLayer(() => {
      if (!loading) {
        close(null);
      }
    });
    void loadEntries();

    safeScopeEl.addEventListener('click', (event) => {
      const scope = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-scope]')
        ?.dataset.scope as ProviderResumeScope | undefined;
      if (!scope || scope === activeScope) {
        return;
      }

      activeScope = scope;
      void loadEntries();
    });

    safeRefreshButton.addEventListener('click', () => {
      void loadEntries();
    });

    safeListEl.addEventListener('click', (event) => {
      const sessionId = (event.target as HTMLElement | null)?.closest<HTMLElement>(
        '[data-session-id]',
      )?.dataset.sessionId;
      if (!sessionId) {
        return;
      }

      const entry = entries.find((item) => item.sessionId === sessionId);
      close(entry ?? null);
    });

    overlay.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      if (target === overlay || target?.closest('[data-role="cancel"]')) {
        close(null);
      }
    });

    cancelButtons.forEach((button) => {
      button.setAttribute('type', 'button');
    });
  });
}

function getProviderLabel(provider: ResumeProvider): string {
  return provider === 'claude' ? 'Claude' : 'Codex';
}

function formatUpdatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}
