import type { LensAttachmentReference, LensTurnRequest } from '../../api/types';
import { getActiveTab } from '../sessionTabs';

export function isLensActiveSession(sessionId: string | null | undefined): boolean {
  return !!sessionId && getActiveTab(sessionId) === 'agent';
}

export function createLensTurnRequest(
  text: string,
  attachments: LensAttachmentReference[] = [],
): LensTurnRequest {
  return {
    text,
    attachments,
  };
}
