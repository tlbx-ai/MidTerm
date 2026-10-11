import { describe, expect, it, vi } from 'vitest';
import { FileEditState } from './editState';

describe('FileEditState', () => {
  it('preserves the unsaved draft and baseline after a failed write', async () => {
    const write = vi.fn().mockRejectedValue(new Error('Permission denied'));
    const edit = new FileEditState('notes.md', 'saved', write);
    edit.content = 'draft';
    await expect(edit.save()).rejects.toThrow('Permission denied');
    expect(edit.content).toBe('draft');
    expect(edit.dirty).toBe(true);
    expect(edit.saving).toBe(false);
    edit.discard();
    expect(edit.content).toBe('saved');
  });

  it('does not clear newer keystrokes when an older snapshot finishes saving', async () => {
    let complete!: () => void;
    const write = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    const edit = new FileEditState('notes.md', 'saved', write);
    edit.content = 'first draft';
    const pending = edit.save();
    expect(edit.save()).toBe(pending);
    edit.content = 'second draft';
    complete();
    expect(await pending).toBe(false);
    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith('first draft');
    expect(edit.content).toBe('second draft');
    expect(edit.dirty).toBe(true);
    edit.discard();
    expect(edit.content).toBe('first draft');
  });

  it('becomes clean only after the current content was successfully written', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const edit = new FileEditState('notes.md', 'saved', write);
    edit.content = 'changed';
    expect(await edit.save()).toBe(true);
    expect(edit.dirty).toBe(false);
    await edit.save();
    expect(write).toHaveBeenCalledOnce();
  });

  it('retains a failed draft until an acknowledged retry actually completes', async () => {
    const write = vi
      .fn()
      .mockRejectedValueOnce(new Error('unknown save outcome'))
      .mockResolvedValueOnce(undefined);
    const edit = new FileEditState('notes.md', 'base', write);
    edit.content = 'draft';
    await expect(edit.save()).rejects.toThrow('unknown save outcome');
    expect(edit.saved).toBe(false);
    expect(edit.dirty).toBe(true);
    expect(edit.lastError?.message).toBe('unknown save outcome');
    expect(await edit.save()).toBe(true);
    expect(edit.dirty).toBe(false);
    expect(edit.lastError).toBeNull();
    expect(edit.saved).toBe(true);
  });
});
