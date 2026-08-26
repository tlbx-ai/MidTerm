import { describe, expect, it } from 'vitest';
import type { LaunchEntry } from '../../api/types';
import { buildLocalBookmarkLaunchRequest } from './bookmarkLaunch';

describe('buildLocalBookmarkLaunchRequest', () => {
  it('keeps the bookmark command inside the atomic session create request', () => {
    const entry = {
      id: 'jpa',
      shellType: 'Pwsh',
      executable: 'node',
      commandLine: 'node codex.js --yolo',
      workingDirectory: 'Q:\\repos\\Jpa',
      isStarred: true,
      order: 1,
    } as LaunchEntry;

    expect(buildLocalBookmarkLaunchRequest(entry, 151, 54)).toEqual({
      cols: 151,
      rows: 54,
      shell: 'Pwsh',
      workingDirectory: 'Q:\\repos\\Jpa',
      launchCommand: 'node codex.js --yolo',
    });
  });
});
