export const PREVIEW_LOAD_TOKEN_DATASET_KEY = 'mtPreviewLoadToken';
export const PREVIEW_LOAD_TOKEN_ATTRIBUTE = 'data-mt-preview-load-token';

export interface PreviewLoadTrackedFrame {
  src: string;
  dataset: DOMStringMap;
}

export function buildPreviewLoadToken(targetUrl: string, targetRevision: number): string {
  return `${targetRevision}:${targetUrl}`;
}

export function shouldReloadPreviewFrame(
  frame: PreviewLoadTrackedFrame,
  proxyUrl: string,
  targetUrl: string,
  targetRevision: number,
): boolean {
  if (frame.src !== proxyUrl) {
    return true;
  }

  return (
    frame.dataset[PREVIEW_LOAD_TOKEN_DATASET_KEY] !==
    buildPreviewLoadToken(targetUrl, targetRevision)
  );
}
