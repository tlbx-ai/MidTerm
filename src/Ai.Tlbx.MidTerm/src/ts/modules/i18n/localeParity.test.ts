import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createLocaleParityReport, STAGED_REQUIRED_PREFIXES } =
  require('../../../../scripts/locale-parity.cjs') as {
    createLocaleParityReport: () => {
      issues: Array<{ type: 'missing' | 'extra'; severity: 'error' | 'warn'; key: string }>;
    };
    STAGED_REQUIRED_PREFIXES: string[];
  };

describe('locale parity', () => {
  it('has no stale extra keys in localized files', () => {
    const report = createLocaleParityReport();
    const extras = report.issues.filter((issue) => issue.type === 'extra');
    expect(extras).toEqual([]);
  });

  it('has no missing keys for the staged high-visibility prefixes', () => {
    const report = createLocaleParityReport();
    const enforcedMissing = report.issues.filter(
      (issue) => issue.type === 'missing' && issue.severity === 'error',
    );
    expect(
      enforcedMissing,
      `Expected parity for prefixes: ${STAGED_REQUIRED_PREFIXES.join(', ')}`,
    ).toEqual([]);
  });
});
