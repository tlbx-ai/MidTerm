import type { Schemas } from '../../api/types';
import { t } from '../i18n';

export type OperationRequest = Schemas['FileOperationRequest'];
export type OperationResult = Schemas['FileOperationResponse'];
export type OperationItem = Schemas['FileOperationItem'];
export type RecoveryEntry = Schemas['FileRecoveryEntry'];
export type RecoveryPage = Schemas['FileRecoveryResponse'];

export class FileOperationError extends Error {
  public constructor(
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? t('fileBrowser.operationFailed'));
  }
}

function confirmed(result: OperationResult, request: OperationRequest): boolean {
  return (
    result.operationId === request.requestId.replace(/-/g, '').toLowerCase() &&
    result.action === request.action &&
    result.complete &&
    Array.isArray(result.items) &&
    result.items.length > 0 &&
    result.items.every(
      (item) =>
        typeof item.success === 'boolean' &&
        (item.success
          ? request.action === 'delete' || typeof item.path === 'string'
          : typeof item.code === 'string'),
    )
  );
}

async function read<T>(response: Response): Promise<T> {
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = data as { code?: string; message?: string } | null;
    throw new FileOperationError(error?.code ?? 'request_failed', error?.message);
  }
  if (typeof data !== 'object' || data === null) throw new FileOperationError('invalid_response');
  return data as T;
}

export async function executeOperation(
  request: OperationRequest,
  sessionId: string,
): Promise<OperationResult> {
  try {
    const response = await fetch(
      `/api/files/operations?sessionId=${encodeURIComponent(sessionId)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      },
    );
    const result = await read<OperationResult>(response);
    if (confirmed(result, request)) return result;
    throw new FileOperationError('invalid_response');
  } catch (error) {
    if (error instanceof FileOperationError && error.code !== 'invalid_response') throw error;
    // A lost acknowledgement never authorizes replaying a filesystem mutation.
    try {
      const response = await fetch(
        `/api/files/operations/${encodeURIComponent(request.requestId)}?sessionId=${encodeURIComponent(sessionId)}`,
      );
      const receipt = await read<OperationResult>(response);
      if (confirmed(receipt, request)) return receipt;
    } catch {
      /* Keep the uncertain result visible; do not issue another POST. */
    }
    throw new FileOperationError('outcome_unknown', t('fileBrowser.operationUnknown'));
  }
}

export async function listRecovery(
  directory: string,
  sessionId: string,
  cursor?: string,
): Promise<RecoveryPage> {
  const params = new URLSearchParams({ directory, sessionId });
  if (cursor) params.set('cursor', cursor);
  return await read<RecoveryPage>(await fetch(`/api/files/recovery?${params}`));
}

export async function restoreEntry(
  id: string,
  sessionId: string,
  conflict = 'fail',
): Promise<OperationItem> {
  try {
    const item = await read<OperationItem>(
      await fetch(`/api/files/restore?sessionId=${encodeURIComponent(sessionId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recoveryId: id, conflict }),
      }),
    );
    if (!item.success || item.recoveryId !== id || typeof item.path !== 'string')
      throw new FileOperationError('outcome_unknown', t('fileBrowser.operationUnknown'));
    return item;
  } catch (error) {
    if (error instanceof FileOperationError) throw error;
    throw new FileOperationError('outcome_unknown', t('fileBrowser.operationUnknown'));
  }
}
