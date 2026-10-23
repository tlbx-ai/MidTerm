import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('../../../static/js/web-preview-popup.js', import.meta.url),
  'utf8',
);
const build = source.slice(
  source.indexOf('  function buildProxyUrl('),
  source.indexOf('  function createForceReloadToken('),
);
const makeUrl = new Function(
  'target',
  `
  var previewOrigin = 'https://localhost:2101';
  var previewContext = { previewId: 'test-preview', previewToken: 'test-capability' };
  var currentTargetRevision = 7;
  function getProxyPrefix() { return '/webpreview/test-route'; }
  ${build}
  return buildProxyUrl(target, 'test-reload');
`,
) as (target: string) => string;

describe('popup preview bootstrap', () => {
  it.each(['', JSON.stringify({ previewId: 'stale-name', previewToken: 'old-name-capability' })])(
    'explicit attachment wins over shared route cookie and window.name %s',
    (name) => {
      const middleware = readFileSync(
        new URL('../../../../Services/WebPreview/WebPreviewProxyMiddleware.cs', import.meta.url),
        'utf8',
      );
      const bootstrap = middleware.slice(
        middleware.indexOf('          if(window.__mtProxy)'),
        middleware.indexOf('          function mtMsg'),
      );
      const run = new Function(
        'window',
        'location',
        'document',
        'history',
        `${bootstrap}; return mtCtx;`,
      ) as (
        window: object,
        location: object,
        document: object,
        history: object,
      ) => { previewId: string; previewToken: string; targetRevision: number };
      const result = run(
        { name, parent: {} },
        {
          search: '?__mtPreviewId=new-window&__mtPreviewToken=new-capability&__mtTargetRevision=42',
          pathname: '/webpreview/route/index.html',
          href: 'https://preview.test/webpreview/route/index.html?__mtPreviewId=new-window&__mtPreviewToken=new-capability&__mtTargetRevision=42',
        },
        {
          cookie: `mt-preview-ctx=${encodeURIComponent(JSON.stringify({ previewId: 'stale-cookie', previewToken: 'old-cookie-capability' }))}`,
        },
        { replaceState: () => {} },
      );
      expect(result).toEqual({
        previewId: 'new-window',
        previewToken: 'new-capability',
        targetRevision: 42,
      });
    },
  );
  it.each(['https://example.test/page?a=1#part', 'file:///C:/local/program/index.html'])(
    'carries scoped identity across a separate preview origin for %s',
    (target) => {
      const url = new URL(makeUrl(target));
      expect(url.origin).toBe('https://localhost:2101');
      expect(url.pathname).toBe('/webpreview/test-route' + new URL(target).pathname);
      expect(url.searchParams.get('__mtPreviewId')).toBe('test-preview');
      expect(url.searchParams.get('__mtPreviewToken')).toBe('test-capability');
      expect(url.searchParams.get('__mtTargetRevision')).toBe('7');
      expect(url.searchParams.get('__mtReloadToken')).toBe('test-reload');
      expect(url.hash).toBe(new URL(target).hash);
    },
  );
});
