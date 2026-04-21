import { ApiProblemError } from './api/client';
import { t } from './modules/i18n';
import { showAlert } from './utils/dialog';

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getSessionLaunchFailure(error: unknown): { message: string; details?: string } {
  if (error instanceof ApiProblemError) {
    const details: string[] = [];
    if (error.errorStage) {
      details.push(`Stage: ${error.errorStage}`);
    }
    if (error.exceptionType) {
      details.push(`Exception: ${error.exceptionType}`);
    }
    if (error.nativeErrorCode !== null) {
      details.push(`Native error code: ${error.nativeErrorCode}`);
    }
    if (error.errorDetails) {
      details.push(error.errorDetails);
    }

    return {
      message: error.detail || error.title || 'Session launch failed.',
      ...(details.length > 0 ? { details: details.join('\n\n') } : {}),
    };
  }

  return {
    message: getErrorMessage(error),
  };
}

export function showSessionLaunchFailure(error: unknown): void {
  const failure = getSessionLaunchFailure(error);
  const options = {
    title: t('sessionLauncher.createFailed'),
    ...(failure.details ? { details: failure.details } : {}),
  };
  void showAlert(failure.message, options);
}

export function getSessionLaunchErrorMessage(error: unknown): string {
  return getErrorMessage(error);
}
