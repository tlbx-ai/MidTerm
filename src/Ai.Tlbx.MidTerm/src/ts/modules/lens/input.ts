import type { SessionPromptRequest } from '../../api/types';
import { getActiveTab } from '../sessionTabs';

export function isLensActiveSession(sessionId: string | null | undefined): boolean {
  return !!sessionId && getActiveTab(sessionId) === 'agent';
}

export function createLensPromptRequest(text: string): SessionPromptRequest {
  return {
    text,
    mode: 'auto',
    interruptFirst: false,
    interruptKeys: ['C-c'],
    literalInterruptKeys: false,
    interruptDelayMs: 150,
    submitKeys: ['Enter'],
    literalSubmitKeys: false,
    submitDelayMs: 300,
    followupSubmitCount: 0,
    followupSubmitDelayMs: 250,
  };
}
