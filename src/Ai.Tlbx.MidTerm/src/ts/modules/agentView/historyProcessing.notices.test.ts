import { describe, expect, it } from 'vitest';
import type { AppServerControlHistoryItem, AppServerControlHistorySnapshot } from '../../api/types';
import { buildAppServerControlHistoryEntries } from './historyProcessing';

function entry(
  id: string,
  kind: string,
  status: string,
  body: string,
  turnId?: string,
  updatedAt = '2026-10-17T00:00:00Z',
): AppServerControlHistoryItem {
  return {
    entryId: id,
    order: Number(id),
    kind,
    status,
    body,
    turnId,
    updatedAt,
    createdAt: updatedAt,
    estimatedHeightPx: 40,
    attachments: [],
    fileMentions: [],
    imagePreviews: [],
    questions: [],
    answers: [],
    streaming: false,
  };
}
function visible(history: AppServerControlHistoryItem[]) {
  return buildAppServerControlHistoryEntries({ history } as AppServerControlHistorySnapshot);
}

describe('native structured warning presentation', () => {
  const detail = 'session-flags: ignored_option is ignored.';
  const summary = 'Codex is ignoring one unrecognized setting.\n' + detail;

  it('shows one warning when native stderr repeats a structured configuration warning', () => {
    const rows = visible([
      entry('1', 'system', 'runtime.warning', detail),
      entry('2', 'notice', 'warning', summary),
      entry('3', 'system', 'runtime.warning', summary),
      entry(
        '4',
        'system',
        'runtime.warning',
        '2026-10-17T00:00:00.123Z ERROR codex_app_server: Codex is ignoring one unrecognized setting.',
      ),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('2');
    expect(rows[0]!.label).toBe('Warning');
    expect(rows[0]!.body).toBe(summary);
  });

  it('retains warnings from another turn or a later occurrence', () => {
    const rows = visible([
      entry('1', 'notice', 'warning', summary, 'first'),
      entry('2', 'system', 'runtime.warning', detail, 'second'),
      entry('3', 'system', 'runtime.warning', detail, 'first', '2026-10-17T00:01:00Z'),
    ]);
    expect(rows).toHaveLength(3);
  });

  it('never hides an error because its text overlaps a warning', () => {
    const rows = visible([
      entry('1', 'notice', 'warning', summary),
      entry('2', 'notice', 'error', summary),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.label)).toEqual(['Warning', 'Error']);
  });

  it('retains a distinct runtime warning and labels it accurately', () => {
    const rows = visible([
      entry('1', 'notice', 'warning', summary),
      entry('2', 'system', 'runtime.warning', 'The provider connection is being retried.'),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.label).toBe('Warning');
  });
});
