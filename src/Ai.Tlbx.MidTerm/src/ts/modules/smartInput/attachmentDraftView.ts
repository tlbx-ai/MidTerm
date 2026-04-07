import { t } from '../i18n';
import type { LensComposerDraftAttachment } from './lensAttachments';

export function renderLensAttachmentDraftView(args: {
  host: HTMLDivElement | null;
  sessionId: string | null;
  attachments: readonly LensComposerDraftAttachment[];
  isLensActiveSession: (sessionId: string) => boolean;
  onRemoveAttachment: (sessionId: string, attachmentId: string) => void;
  onFocusTextarea: () => void;
}): void {
  const { attachments, host, isLensActiveSession, onFocusTextarea, onRemoveAttachment, sessionId } =
    args;
  if (!host) {
    return;
  }

  host.replaceChildren();
  if (!sessionId || !isLensActiveSession(sessionId)) {
    host.hidden = true;
    return;
  }

  if (attachments.length === 0) {
    host.hidden = true;
    return;
  }

  for (const attachment of attachments) {
    const chip = document.createElement('div');
    chip.className = `smart-input-attachment-chip smart-input-attachment-chip-${attachment.kind}`;
    chip.title = attachment.displayName;

    if (attachment.previewUrl) {
      const preview = document.createElement('img');
      preview.className = 'smart-input-attachment-thumb';
      preview.src = attachment.previewUrl;
      preview.alt = attachment.displayName;
      chip.appendChild(preview);
    } else {
      const icon = document.createElement('span');
      icon.className = 'smart-input-attachment-icon';
      icon.textContent = t('smartInput.fileBadge');
      chip.appendChild(icon);
    }

    const label = document.createElement('span');
    label.className = 'smart-input-attachment-label';
    label.textContent = attachment.displayName;
    chip.appendChild(label);

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'smart-input-attachment-remove';
    removeButton.textContent = '×';
    removeButton.title = `${t('smartInput.removeAttachment')} ${attachment.displayName}`;
    removeButton.setAttribute(
      'aria-label',
      `${t('smartInput.removeAttachment')} ${attachment.displayName}`,
    );
    removeButton.addEventListener('click', () => {
      onRemoveAttachment(sessionId, attachment.id);
      onFocusTextarea();
    });
    chip.appendChild(removeButton);

    host.appendChild(chip);
  }

  host.hidden = false;
}
