import type { Schemas } from '../../api/types';
import { t } from '../i18n';

export type FileDocument = Schemas['FileDocumentResponse'];
type FileDocumentErrorBody = Partial<Schemas['FileDocumentErrorResponse']>;
type FileSaveResult = Schemas['FileSaveResponse'];

const ERROR_KEYS: Record<string, string> = {
  changed: 'fileViewer.conflict',
  changed_during_save: 'fileViewer.conflict',
  access_denied: 'fileViewer.errorPermission',
  unauthenticated: 'fileViewer.errorLogin',
  deleted: 'fileViewer.errorDeleted',
  session_closed: 'fileViewer.errorSession',
  busy: 'fileViewer.errorBusy',
  disk_full: 'fileViewer.errorDiskFull',
  version_required: 'fileViewer.errorVersion',
  too_large: 'fileViewer.errorTooLarge',
  unsupported_encoding: 'fileViewer.errorEncoding',
  network_error: 'fileViewer.errorUnknownSave',
  invalid_response: 'fileViewer.errorUnknownSave',
  io_error: 'fileViewer.errorWrite',
  save_failed: 'fileViewer.errorWrite',
};

function errorKey(code: string): string {
  return Object.prototype.hasOwnProperty.call(ERROR_KEYS, code)
    ? (ERROR_KEYS[code] ?? 'fileViewer.errorWrite')
    : 'fileViewer.errorWrite';
}

export class FileDocumentError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly currentVersion: string | null = null,
    public readonly recoveryPath: string | null = null,
  ) {
    super(t(errorKey(code)));
  }

  public get outcomeUnknown(): boolean {
    return this.code === 'network_error' || this.code === 'invalid_response';
  }
}

function query(path: string, sessionId: string | null): URLSearchParams {
  const params = new URLSearchParams({ path });
  if (sessionId) params.set('sessionId', sessionId);
  return params;
}

async function checked(response: Response): Promise<void> {
  if (response.ok) return;
  const payload: unknown = await response.json().catch(() => null);
  const body =
    typeof payload === 'object' && payload !== null ? (payload as FileDocumentErrorBody) : {};
  const statusCodes: Record<number, string> = {
    401: 'unauthenticated',
    403: 'access_denied',
    404: 'deleted',
    413: 'too_large',
    423: 'busy',
    507: 'disk_full',
  };
  throw new FileDocumentError(
    response.status,
    typeof body.code === 'string' ? body.code : (statusCodes[response.status] ?? 'request_failed'),
    typeof body.currentVersion === 'string' ? body.currentVersion : null,
    typeof body.recoveryPath === 'string' ? body.recoveryPath : null,
  );
}

export async function readFileDocument(
  path: string,
  sessionId: string | null,
  full: boolean,
  signal: AbortSignal,
): Promise<FileDocument> {
  const params = query(path, sessionId);
  params.set('full', String(full));
  const response = await fetch(`/api/files/document?${params}`, { signal });
  await checked(response);
  const document = (await response.json()) as FileDocument;
  if (
    document.path !== path ||
    typeof document.content !== 'string' ||
    typeof document.size !== 'number' ||
    (document.version !== null && typeof document.version !== 'string')
  )
    throw new FileDocumentError(502, 'invalid_response');
  return document;
}

export async function writeFileDocument(
  path: string,
  sessionId: string | null,
  content: string,
  version: string | null,
): Promise<FileSaveResult> {
  if (!version) throw new FileDocumentError(428, 'version_required');
  const params = new URLSearchParams();
  if (sessionId) params.set('sessionId', sessionId);
  const suffix = params.size ? `?${params}` : '';
  const response = await fetch(`/api/files/save${suffix}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content, expectedVersion: version }),
  }).catch(() => {
    throw new FileDocumentError(0, 'network_error');
  });
  await checked(response);
  const payload: unknown = await response.json().catch(() => null);
  const saved =
    typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
  if (
    saved.success !== true ||
    typeof saved.version !== 'string' ||
    !saved.version ||
    typeof saved.size !== 'number' ||
    typeof saved.encoding !== 'string' ||
    typeof saved.lineEnding !== 'string'
  )
    throw new FileDocumentError(502, 'invalid_response');
  return {
    success: true,
    version: saved.version,
    size: saved.size,
    encoding: saved.encoding,
    lineEnding: saved.lineEnding,
  };
}
