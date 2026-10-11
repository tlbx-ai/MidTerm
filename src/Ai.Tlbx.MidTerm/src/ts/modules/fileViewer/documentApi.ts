import type { Schemas } from '../../api/types';
import { t } from '../i18n';

export type FileDocument = Schemas['FileDocumentResponse'];
type FileDocumentErrorBody = Partial<Schemas['FileDocumentErrorResponse']>;
type FileSaveResult = Schemas['FileSaveResponse'];

export class FileDocumentError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly currentVersion: string | null = null,
    public readonly recoveryPath: string | null = null,
  ) {
    super(
      t(
        code === 'changed' || code === 'changed_during_save'
          ? 'fileViewer.conflict'
          : 'fileViewer.saveFailed',
      ) + ` (${status})`,
    );
  }
}

function query(path: string, sessionId: string | null): URLSearchParams {
  const params = new URLSearchParams({ path });
  if (sessionId) params.set('sessionId', sessionId);
  return params;
}

async function checked(response: Response): Promise<void> {
  if (response.ok) return;
  const body = (await response.json().catch(() => ({}))) as FileDocumentErrorBody;
  throw new FileDocumentError(
    response.status,
    body.code ?? 'request_failed',
    body.currentVersion ?? null,
    body.recoveryPath ?? null,
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
  });
  await checked(response);
  const saved = (await response.json()) as Record<string, unknown>;
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
