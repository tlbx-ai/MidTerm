import type { BrowserPreviewClientResponse } from './webApi';

const PREVIEW_QUERY_ID_PARAM = '__mtPreviewId';
const PREVIEW_QUERY_TOKEN_PARAM = '__mtPreviewToken';
const PREVIEW_QUERY_TARGET_REVISION_PARAM = '__mtTargetRevision';

export function buildProxyUrl(
  targetUrl: string,
  previewClient: BrowserPreviewClientResponse,
  targetRevision: number,
  frameOrigin = window.location.origin,
): string {
  const parsed = new URL(targetUrl);
  const path = parsed.pathname || '/';
  const prefix = `/webpreview/${encodeURIComponent(previewClient.routeKey)}`;
  const proxyUrl = new URL(path === '/' ? `${prefix}/` : `${prefix}${path}`, frameOrigin);
  proxyUrl.search = parsed.search;
  proxyUrl.hash = parsed.hash;
  if (previewClient.previewId && previewClient.previewToken) {
    proxyUrl.searchParams.set(PREVIEW_QUERY_ID_PARAM, previewClient.previewId);
    proxyUrl.searchParams.set(PREVIEW_QUERY_TOKEN_PARAM, previewClient.previewToken);
  }
  proxyUrl.searchParams.set(PREVIEW_QUERY_TARGET_REVISION_PARAM, String(targetRevision));
  return proxyUrl.toString();
}

export function stripInternalPreviewQueryParams(url: URL): void {
  url.searchParams.delete(PREVIEW_QUERY_ID_PARAM);
  url.searchParams.delete(PREVIEW_QUERY_TOKEN_PARAM);
  url.searchParams.delete(PREVIEW_QUERY_TARGET_REVISION_PARAM);
}
