import { afterEach, describe, expect, it } from 'vitest';
import type { TerminalSizeControlStatus } from '../types';
import {
  getTerminalSizeControl,
  removeTerminalSizeControlSource,
  setTerminalSizeControl,
  setTerminalSizeControlsForSource,
} from './index';

const source = 'hub:race-test';
const sessionId = 'hub:race-test:session-1';

function status(epoch: number, isOwner: boolean): TerminalSizeControlStatus {
  return {
    sessionId,
    isOwner,
    hasOwner: true,
    ownerOnline: true,
    canTakeOverAutomatically: isOwner,
    epoch,
  };
}

describe('terminal size-control projection', () => {
  afterEach(() => {
    removeTerminalSizeControlSource(source);
  });

  it('does not let a delayed command response regress an authoritative epoch', () => {
    setTerminalSizeControlsForSource(source, [status(9, false)]);

    setTerminalSizeControl(status(8, true));

    expect(getTerminalSizeControl(sessionId)).toEqual(status(9, false));
  });

  it('accepts same-epoch online-state updates and newer ownership epochs', () => {
    setTerminalSizeControlsForSource(source, [status(9, false)]);
    const offline = { ...status(9, false), ownerOnline: false };

    setTerminalSizeControl(offline);
    expect(getTerminalSizeControl(sessionId)?.ownerOnline).toBe(false);

    setTerminalSizeControl(status(10, true));
    expect(getTerminalSizeControl(sessionId)).toEqual(status(10, true));
  });
});
