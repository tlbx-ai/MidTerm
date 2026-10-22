import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPdfView } from './pdfView';

afterEach(() => vi.unstubAllGlobals());

describe('embedded PDF viewer', () => {
  it('removes the rendering frame when its document load is cancelled', () => {
    const remove = vi.fn();
    vi.stubGlobal('document', {
      documentElement: { lang: 'en', dataset: {} },
      createElement: () => ({ remove }),
    });
    const controller = new AbortController();
    createPdfView('/api/files/view?path=test.pdf', 'file-viewer-pdf', controller.signal);
    expect(remove).not.toHaveBeenCalled();
    controller.abort();
    expect(remove).toHaveBeenCalledOnce();
  });

  it('keeps authenticated file URLs and special filenames inside a local viewer URL', () => {
    vi.stubGlobal('document', {
      documentElement: { lang: 'de', dataset: { nativeColorScheme: 'light' } },
      createElement: () => ({}),
    });
    const file =
      '/api/files/view?path=' +
      encodeURIComponent('Q:\\Dokumente\\Größe & "Plan" #1.pdf') +
      '&sessionId=abc';
    const frame = createPdfView(file, 'preview-pdf');
    const url = new URL(frame.src, 'https://tlbx.test');
    expect(url.pathname).toBe('/pdf/index.html');
    expect(url.searchParams.get('file')).toBe(file);
    expect(url.searchParams.get('lang')).toBe('de');
    expect(frame.className).toBe('preview-pdf');
    expect(frame.title).toBe('PDF');
  });
});
