import { describe, expect, it } from 'vitest';
import {
  armOutputRttMeasurement,
  consumeCompletedOutputRtt,
  createOutputRttTracker,
  recordOutputRttInput,
  resetOutputRttTracker,
} from './outputRttTracker';

describe('outputRttTracker', () => {
  it('waits for the first post-input output before arming RTT completion', () => {
    const tracker = createOutputRttTracker();

    recordOutputRttInput(tracker, 'sess1234', 10);
    expect(consumeCompletedOutputRtt(tracker, 'sess1234', 25)).toBeNull();

    armOutputRttMeasurement(tracker, 'sess1234');

    expect(consumeCompletedOutputRtt(tracker, 'sess1234', 25)).toBe(15);
    expect(consumeCompletedOutputRtt(tracker, 'sess1234', 30)).toBeNull();
  });

  it('does not arm twice for the same pending RTT', () => {
    const tracker = createOutputRttTracker();

    recordOutputRttInput(tracker, 'sess1234', 10);
    armOutputRttMeasurement(tracker, 'sess1234');
    recordOutputRttInput(tracker, 'sess1234', 20);
    armOutputRttMeasurement(tracker, 'sess1234');

    expect(consumeCompletedOutputRtt(tracker, 'sess1234', 40)).toBe(30);
    expect(consumeCompletedOutputRtt(tracker, 'sess1234', 50)).toBeNull();
  });

  it('ignores output when no local input timestamp exists', () => {
    const tracker = createOutputRttTracker();

    armOutputRttMeasurement(tracker, 'sess1234');

    expect(consumeCompletedOutputRtt(tracker, 'sess1234', 20)).toBeNull();
  });

  it('clears pending and armed timestamps on reset', () => {
    const tracker = createOutputRttTracker();

    recordOutputRttInput(tracker, 'sess1234', 10);
    recordOutputRttInput(tracker, 'sess5678', 20);
    armOutputRttMeasurement(tracker, 'sess1234');

    resetOutputRttTracker(tracker);

    expect(consumeCompletedOutputRtt(tracker, 'sess1234', 40)).toBeNull();
    expect(consumeCompletedOutputRtt(tracker, 'sess5678', 40)).toBeNull();
  });
});
