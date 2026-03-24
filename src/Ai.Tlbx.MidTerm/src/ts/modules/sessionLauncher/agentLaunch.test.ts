import { describe, expect, it } from 'vitest';
import { buildAgentLaunchCommand, parseEnvironmentVariables } from './agentLaunch';

const baseSettings = {
  codexYoloDefault: false,
  codexEnvironmentVariables: '',
  claudeDangerouslySkipPermissionsDefault: false,
  claudeEnvironmentVariables: '',
} as any;

describe('agentLaunch', () => {
  it('parses newline-delimited environment variables', () => {
    expect(parseEnvironmentVariables('FOO=bar\nBAR=baz')).toEqual({
      FOO: 'bar',
      BAR: 'baz',
    });
  });

  it('rejects invalid environment variable lines', () => {
    expect(() => parseEnvironmentVariables('not valid')).toThrow(
      'Invalid environment variable line: not valid',
    );
  });

  it('builds a PowerShell Codex command with env vars and --yolo', () => {
    const command = buildAgentLaunchCommand(
      'codex',
      'Pwsh',
      {
        ...baseSettings,
        codexYoloDefault: true,
        codexEnvironmentVariables: "FOO=bar\nQUOTE=it's",
      },
    );

    expect(command).toBe("$env:FOO='bar'; $env:QUOTE='it''s'; codex --yolo");
  });

  it('builds a bash Claude command with env vars and default flag', () => {
    const command = buildAgentLaunchCommand(
      'claude',
      'Bash',
      {
        ...baseSettings,
        claudeDangerouslySkipPermissionsDefault: true,
        claudeEnvironmentVariables: "FOO=bar baz\nQUOTE=it's",
      },
    );

    expect(command).toBe(
      "env FOO='bar baz' QUOTE='it'\"'\"'s' claude --dangerously-skip-permissions",
    );
  });

  it('builds a cmd command with env vars', () => {
    const command = buildAgentLaunchCommand(
      'codex',
      'Cmd',
      {
        ...baseSettings,
        codexEnvironmentVariables: 'FOO=bar',
      },
    );

    expect(command).toBe('set "FOO=bar"&& codex');
  });
});
