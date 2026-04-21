import { describe, expect, it } from 'vitest';

import { formatHistoryDirectoryDisplay } from './historyPathDisplay';

describe('history path display', () => {
  it('leaves short directories untouched', () => {
    expect(formatHistoryDirectoryDisplay('Q:\\repos\\MidTermWorkspace3', 64)).toBe(
      'Q:\\repos\\MidTermWorkspace3',
    );
  });

  it('compresses long windows paths from the middle', () => {
    expect(formatHistoryDirectoryDisplay('Q:\\repos\\MidTermWorkspace3', 24)).toBe(
      'Q:\\…\\MidTermWorkspace3',
    );
  });

  it('keeps the last two segments when they still fit', () => {
    expect(
      formatHistoryDirectoryDisplay('C:\\Users\\johan\\My Drive\\Predigten', 32),
    ).toBe('C:\\Users\\…\\My Drive\\Predigten');
  });

  it('handles posix-style paths', () => {
    expect(formatHistoryDirectoryDisplay('/workspace/src/modules/history', 24)).toBe(
      '/workspace/…/history',
    );
  });
});
