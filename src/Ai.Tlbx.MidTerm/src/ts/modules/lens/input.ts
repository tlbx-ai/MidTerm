import { sendLensTurn } from '../../api/client';
import type {
  LensAttachmentReference,
  LensTurnRequest,
  LensTurnStartResponse,
} from '../../api/types';
import { getActiveTab } from '../sessionTabs';

export const LENS_TURN_SUBMITTED_EVENT = 'midterm:lens-turn-submitted';
export const LENS_TURN_ACCEPTED_EVENT = 'midterm:lens-turn-accepted';
export const LENS_TURN_FAILED_EVENT = 'midterm:lens-turn-failed';

export interface LensTurnSubmittedEventDetail {
  optimisticId: string;
  sessionId: string;
  request: LensTurnRequest;
}

export interface LensTurnAcceptedEventDetail extends LensTurnSubmittedEventDetail {
  response: LensTurnStartResponse;
}

export interface LensTurnFailedEventDetail extends LensTurnSubmittedEventDetail {
  errorMessage: string;
}

type LensTurnLifecycleEventDetail =
  | LensTurnSubmittedEventDetail
  | LensTurnAcceptedEventDetail
  | LensTurnFailedEventDetail;

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

export async function submitLensTurn(
  sessionId: string,
  request: LensTurnRequest,
): Promise<LensTurnStartResponse> {
  const optimisticId = createOptimisticTurnId();
  const normalizedRequest = {
    ...(request.text === undefined ? {} : { text: request.text }),
    attachments: request.attachments.map((attachment) => ({ ...attachment })),
  };

  dispatchLensTurnEvent(LENS_TURN_SUBMITTED_EVENT, {
    optimisticId,
    sessionId,
    request: normalizedRequest,
  });

  try {
    const response = await sendLensTurn(sessionId, normalizedRequest);
    dispatchLensTurnEvent(LENS_TURN_ACCEPTED_EVENT, {
      optimisticId,
      sessionId,
      request: normalizedRequest,
      response,
    });
    return response;
  } catch (error) {
    dispatchLensTurnEvent(LENS_TURN_FAILED_EVENT, {
      optimisticId,
      sessionId,
      request: normalizedRequest,
      errorMessage: String(error),
    });
    throw error;
  }
}

function dispatchLensTurnEvent(name: string, detail: LensTurnLifecycleEventDetail): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') {
    return;
  }

  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function createOptimisticTurnId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `optimistic-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
