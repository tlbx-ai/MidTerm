import type { SpaceWorkspaceDto } from '../../api/types';
import { t } from '../i18n';

export function createSpaceChevron(): HTMLSpanElement {
  const chevron = document.createElement('span');
  chevron.className = 'network-section-chevron icon spaces-tree-section-chevron';
  chevron.innerHTML = '&#xe910;';
  chevron.setAttribute('aria-hidden', 'true');
  return chevron;
}

export function appendWorkspaceBadges(container: HTMLElement, workspace: SpaceWorkspaceDto): void {
  if (workspace.branch) {
    container.appendChild(createTextSpan('spaces-tree-workspace-branch', workspace.branch));
  }
  if (workspace.isDetached) {
    container.appendChild(createTextSpan('spaces-tree-workspace-badge', t('spaces.detached')));
  }
  if (workspace.locked) {
    container.appendChild(createTextSpan('spaces-tree-workspace-badge', t('spaces.locked')));
  }
  if (workspace.prunable) {
    container.appendChild(createTextSpan('spaces-tree-workspace-badge', t('spaces.prunable')));
  }
  if (workspace.hasChanges) {
    container.appendChild(
      createTextSpan('spaces-tree-workspace-badge warn', String(workspace.changeCount)),
    );
  }
}

export function createTextSpan(className: string, value: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = value;
  return span;
}
