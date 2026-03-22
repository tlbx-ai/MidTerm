import { describe, expect, it } from 'vitest';
import {
  computeNextScheduleTime,
  getManagerBarHeatResumeAt,
  intervalToMs,
  isManagerBarCooldownReady,
  isImmediateManagerAction,
  MANAGER_BAR_COOLDOWN_HEAT_THRESHOLD,
  MANAGER_BAR_POST_TRIGGER_IGNORE_HEAT_MS,
  normalizeManagerBarButton,
  shouldManagerActionWaitForInitialCooldown,
} from './workflow';

describe('managerBar workflow', () => {
  it('migrates legacy text entries into single fire-and-forget prompts', () => {
    const button = normalizeManagerBarButton({
      id: '1',
      label: 'Commit',
      text: 'git commit -am "msg"',
    });

    expect(button.actionType).toBe('single');
    expect(button.prompts).toEqual(['git commit -am "msg"']);
    expect(button.trigger.kind).toBe('fireAndForget');
    expect(isImmediateManagerAction(button)).toBe(true);
  });

  it('preserves chain prompts and normalizes trigger settings', () => {
    const button = normalizeManagerBarButton({
      id: '2',
      label: 'Release',
      actionType: 'chain',
      prompts: ['build', 'publish'],
      trigger: {
        kind: 'repeatInterval',
        repeatEveryValue: 2,
        repeatEveryUnit: 'hours',
      },
    });

    expect(button.actionType).toBe('chain');
    expect(button.prompts).toEqual(['build', 'publish']);
    expect(intervalToMs(button.trigger)).toBe(2 * 60 * 60 * 1000);
    expect(shouldManagerActionWaitForInitialCooldown(button)).toBe(true);
  });

  it('keeps only repeat and cooldown triggers behind the initial heat gate', () => {
    const fireAndForget = normalizeManagerBarButton({
      id: 'fire',
      label: 'Now',
      prompts: ['echo now'],
      trigger: { kind: 'fireAndForget' },
    });
    const onCooldown = normalizeManagerBarButton({
      id: 'cooldown',
      label: 'When idle',
      prompts: ['echo later'],
      trigger: { kind: 'onCooldown' },
    });
    const repeatCount = normalizeManagerBarButton({
      id: 'repeat-count',
      label: 'Repeat count',
      prompts: ['echo repeat'],
      trigger: { kind: 'repeatCount', repeatCount: 3 },
    });
    const schedule = normalizeManagerBarButton({
      id: 'schedule',
      label: 'Scheduled',
      prompts: ['echo schedule'],
      trigger: { kind: 'schedule', schedule: [{ timeOfDay: '09:00', repeat: 'daily' }] },
    });

    expect(shouldManagerActionWaitForInitialCooldown(fireAndForget)).toBe(false);
    expect(shouldManagerActionWaitForInitialCooldown(onCooldown)).toBe(true);
    expect(shouldManagerActionWaitForInitialCooldown(repeatCount)).toBe(true);
    expect(shouldManagerActionWaitForInitialCooldown(schedule)).toBe(false);
  });

  it('finds the next matching schedule slot', () => {
    const start = new Date(2026, 2, 20, 8, 30, 0, 0).getTime();
    const next = computeNextScheduleTime(
      [
        { timeOfDay: '09:00', repeat: 'daily' },
        { timeOfDay: '18:00', repeat: 'weekdays' },
      ],
      start,
    );

    expect(next).toBe(new Date(2026, 2, 20, 9, 0, 0, 0).getTime());
  });

  it('holds cooldown measurement for five seconds after a trigger', () => {
    const triggeredAt = 1_000;
    const ignoreUntil = getManagerBarHeatResumeAt(triggeredAt);

    expect(ignoreUntil).toBe(triggeredAt + MANAGER_BAR_POST_TRIGGER_IGNORE_HEAT_MS);
    expect(
      isManagerBarCooldownReady(
        MANAGER_BAR_COOLDOWN_HEAT_THRESHOLD,
        ignoreUntil - 1,
        ignoreUntil,
      ),
    ).toBe(false);
    expect(
      isManagerBarCooldownReady(
        MANAGER_BAR_COOLDOWN_HEAT_THRESHOLD,
        ignoreUntil,
        ignoreUntil,
      ),
    ).toBe(true);
    expect(isManagerBarCooldownReady(0.26, ignoreUntil, ignoreUntil)).toBe(false);
  });
});
