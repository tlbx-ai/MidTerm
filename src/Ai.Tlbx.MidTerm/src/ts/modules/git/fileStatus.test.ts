import { describe, expect, it, vi } from 'vitest';
import { fileStatusPresentation } from './fileStatus';

vi.mock('../i18n', () => ({ t: (key: string) => key }));

describe('shared Files and Git status presentation', () => {
  it('distinguishes untracked U from staged added A and normalizes conflict aliases', () => {
    expect(fileStatusPresentation('untracked')).toEqual(fileStatusPresentation('U'));
    expect(fileStatusPresentation('?')).toEqual(fileStatusPresentation('U'));
    expect(fileStatusPresentation('added')?.letter).toBe('A');
    expect(fileStatusPresentation('untracked')?.letter).toBe('U');
    expect(fileStatusPresentation('unmerged')).toEqual(fileStatusPresentation('!'));
  });

  it('explains aggregated folder status and omits unknown or clean status', () => {
    expect(fileStatusPresentation('D', true)?.label).toBe(
      'git.fileStatus.contains: git.fileStatus.deleted',
    );
    expect(fileStatusPresentation(null)).toBeNull();
    expect(fileStatusPresentation('unknown')).toBeNull();
    expect(fileStatusPresentation('constructor')).toBeNull();
  });
});
