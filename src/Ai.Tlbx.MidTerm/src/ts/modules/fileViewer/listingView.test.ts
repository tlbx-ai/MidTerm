import { describe, expect, it, vi } from 'vitest';
import {
  fileType,
  getListingView,
  matchesListing,
  setListingView,
  sortListing,
  type FileViewOptions,
  type ListingEntry,
} from './listingView';
vi.mock('../i18n', () => ({ getCurrentLocale: () => 'en', t: (key: string) => key }));
const defaults: FileViewOptions = { mode: 'details', sort: 'name', descending: false, query: '' };
describe('file listing presentation', () => {
  it('uses natural names while keeping folders first without mutating the listing', () => {
    const entries = [
      { name: 'file10.txt', isDirectory: false },
      { name: 'file2.txt', isDirectory: false },
      { name: 'z folder', isDirectory: true },
    ];
    expect(sortListing(entries, defaults).map((entry) => entry.name)).toEqual([
      'z folder',
      'file2.txt',
      'file10.txt',
    ]);
    expect(entries[0]?.name).toBe('file10.txt');
  });
  it('finds newest files by actual timestamps and keeps unavailable metadata last', () => {
    const entries: ListingEntry[] = [
      { name: 'unknown', isDirectory: false },
      { name: 'old', isDirectory: false, modified: '2025-01-01T00:00:00Z' },
      { name: 'new', isDirectory: false, modified: '2026-01-01T00:00:00Z' },
    ];
    expect(
      sortListing(entries, { ...defaults, sort: 'modified', descending: true }).map(
        (entry) => entry.name,
      ),
    ).toEqual(['new', 'old', 'unknown']);
  });
  it('sorts sizes numerically including zero and missing sizes', () => {
    const entries = [
      { name: 'zero', isDirectory: false, size: 0 },
      { name: 'large', isDirectory: false, size: 100 },
      { name: 'unknown', isDirectory: false },
    ];
    expect(
      sortListing(entries, { ...defaults, sort: 'size', descending: true }).map(
        (entry) => entry.name,
      ),
    ).toEqual(['large', 'zero', 'unknown']);
  });
  it('filters file types and Unicode names locally and treats a dotfile as a filename', () => {
    expect(matchesListing({ name: 'Öffentlicher Plan.PDF', isDirectory: false }, 'pdf')).toBe(true);
    expect(matchesListing({ name: 'Öffentlicher Plan.PDF', isDirectory: false }, 'öff')).toBe(true);
    expect(matchesListing({ name: 'image.png', isDirectory: false }, 'pdf')).toBe(false);
    expect(fileType({ name: '.gitignore', isDirectory: false, mimeType: 'text/plain' })).toBe(
      'text/plain',
    );
  });
  it('preserves independent working-context preferences and returns isolated snapshots', () => {
    setListingView('test-context-one', { ...defaults, mode: 'icons', query: 'pdf' });
    const first = getListingView('test-context-one', false);
    first.query = 'changed';
    expect(getListingView('test-context-one', false).query).toBe('pdf');
    expect(getListingView('test-context-two', true).mode).toBe('tree');
  });
});
