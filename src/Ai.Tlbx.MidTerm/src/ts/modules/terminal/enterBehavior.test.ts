import { describe, expect, it } from 'vitest';
import {
  getTerminalEnterOverride,
  isPowerShellEnterTarget,
  type EnterOverrideInput,
} from './enterBehavior';

function key(
  value: string,
  mods: Partial<Pick<EnterOverrideInput, 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>> = {},
): EnterOverrideInput {
  return {
    key: value,
    ctrlKey: mods.ctrlKey ?? false,
    shiftKey: mods.shiftKey ?? false,
    altKey: mods.altKey ?? false,
    metaKey: mods.metaKey ?? false,
  };
}

describe('getTerminalEnterOverride', () => {
  it('always maps Ctrl+Enter to line feed', () => {
    expect(getTerminalEnterOverride(key('Enter', { ctrlKey: true }), 'default')).toBe('\n');
    expect(getTerminalEnterOverride(key('Enter', { ctrlKey: true }), 'shiftEnterLineFeed')).toBe(
      '\n',
    );
  });

  it('maps Shift+Enter to line feed only when enabled', () => {
    expect(getTerminalEnterOverride(key('Enter', { shiftKey: true }), 'default')).toBeNull();
    expect(
      getTerminalEnterOverride(key('Enter', { shiftKey: true }), 'shiftEnterLineFeed'),
    ).toBe('\n');
  });

  it('uses PSReadLine VT sequences for modified Enter in PowerShell', () => {
    expect(getTerminalEnterOverride(key('Enter', { shiftKey: true }), 'shiftEnterLineFeed', 'powershell')).toBe(
      '\x1b[13;2u',
    );
    expect(getTerminalEnterOverride(key('Enter', { ctrlKey: true }), 'shiftEnterLineFeed', 'powershell')).toBe(
      '\x1b[13;5u',
    );
    expect(
      getTerminalEnterOverride(
        key('Enter', { ctrlKey: true, shiftKey: true }),
        'shiftEnterLineFeed',
        'powershell',
      ),
    ).toBe('\x1b[13;6u');
  });

  it('leaves Alt+Enter and plain Enter on the xterm default path', () => {
    expect(getTerminalEnterOverride(key('Enter'), 'shiftEnterLineFeed')).toBeNull();
    expect(getTerminalEnterOverride(key('Enter', { altKey: true }), 'shiftEnterLineFeed')).toBeNull();
  });
});

describe('isPowerShellEnterTarget', () => {
  it('detects pwsh foreground processes', () => {
    expect(isPowerShellEnterTarget('pwsh.exe', null)).toBe(true);
    expect(isPowerShellEnterTarget('powershell', null)).toBe(true);
    expect(isPowerShellEnterTarget(null, 'C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe(true);
  });

  it('does not treat other shells as PowerShell', () => {
    expect(isPowerShellEnterTarget('bash', '/bin/bash')).toBe(false);
  });
});
