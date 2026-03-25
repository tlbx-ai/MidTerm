import { describe, expect, it } from 'vitest';

import { sanitizePreviewDisplayUrl, stripInternalPreviewQueryParams } from './previewProxyUrl';

describe('previewProxyUrl', () => {
  it('removes internal preview parameters from display URLs', () => {
    expect(
      sanitizePreviewDisplayUrl(
        'https://example.com/?foo=1&__mtPreviewId=pid&__mtPreviewToken=ptk&__mtTargetRevision=2#frag',
      ),
    ).toBe('https://example.com/?foo=1#frag');
  });

  it('strips internal parameters from parsed proxy URLs', () => {
    const url = new URL(
      'https://midterm.local/webpreview/route/?foo=1&__mtPreviewId=pid&__mtPreviewToken=ptk&__mtTargetRevision=2#frag',
    );

    stripInternalPreviewQueryParams(url);

    expect(url.toString()).toBe('https://midterm.local/webpreview/route/?foo=1#frag');
  });
});
