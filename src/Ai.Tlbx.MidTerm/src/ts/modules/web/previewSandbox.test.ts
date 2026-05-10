import { describe, expect, it } from 'vitest';

import { shouldForceSandboxForTarget, shouldSandboxPreviewFrame } from './previewSandbox';

describe('preview sandbox policy', () => {
  it('forces sandbox for external https targets outside dev mode', () => {
    expect(
      shouldForceSandboxForTarget('https://www.wetter.com/wetter_aktuell', 'https://midterm.local'),
    ).toBe(true);
  });

  it('forces sandbox for local file targets outside dev mode', () => {
    expect(
      shouldForceSandboxForTarget('file:///C:/temp/example.html', 'https://midterm.local'),
    ).toBe(true);
  });

  it('keeps localhost previews unsandboxed outside dev mode', () => {
    expect(shouldForceSandboxForTarget('http://localhost:3000/app', 'https://midterm.local')).toBe(
      false,
    );
  });

  it('keeps same-host previews unsandboxed outside dev mode', () => {
    expect(
      shouldForceSandboxForTarget('https://midterm.local:3001/app', 'https://midterm.local'),
    ).toBe(false);
  });

  it('sandboxes every preview in dev mode', () => {
    expect(
      shouldSandboxPreviewFrame('http://localhost:3000/app', true, 'https://midterm.local'),
    ).toBe(true);
  });
});
