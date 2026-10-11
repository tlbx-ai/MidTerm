import { describe, expect, it } from 'vitest';
import { FileNavigationHistory } from './navigationHistory';

describe('file visit history', () => {
  it('returns from a file to its directory selection and scroll, then goes forward', () => {
    const history = new FileNavigationHistory();
    history.push('root/child');
    Object.assign(history.current!, { scrollTop: 700, selectedPath: 'root/child/file' });
    history.push('root/child/file');
    history.back();
    expect(history.current).toEqual({
      path: 'root/child',
      scrollTop: 700,
      selectedPath: 'root/child/file',
    });
    expect(history.forwardPath).toBe('root/child/file');
    history.forward();
    expect(history.current?.path).toBe('root/child/file');
  });
  it('drops the forward branch only after a new visit and keeps duplicate opens out', () => {
    const history = new FileNavigationHistory();
    history.push('root');
    history.push('a');
    history.push('b');
    history.back();
    expect(history.canForward).toBe(true);
    history.push('c');
    expect(history.canForward).toBe(false);
    expect(history.backPath).toBe('a');
    history.push('c');
    history.back();
    expect(history.current?.path).toBe('a');
    history.clear();
    expect(history.canBack).toBe(false);
    expect(history.canForward).toBe(false);
  });
});
