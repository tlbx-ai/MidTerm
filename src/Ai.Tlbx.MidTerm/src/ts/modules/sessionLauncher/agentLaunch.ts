import type { MidTermSettingsPublic, ShellType } from '../../api/types';

export type LauncherAgentProfile = 'codex' | 'claude';

const ENVIRONMENT_VARIABLE_LINE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=.*$/;

export function parseEnvironmentVariables(text: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    if (!ENVIRONMENT_VARIABLE_LINE_PATTERN.test(line)) {
      throw new Error(`Invalid environment variable line: ${line}`);
    }

    const separator = line.indexOf('=');
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    result[key] = value;
  }

  return result;
}

export function buildAgentLaunchCommand(
  profile: LauncherAgentProfile,
  shell: ShellType | null,
  settings: MidTermSettingsPublic,
): string {
  const command = buildBaseCommand(profile, settings);
  const env = parseEnvironmentVariables(
    profile === 'codex' ? settings.codexEnvironmentVariables : settings.claudeEnvironmentVariables,
  );

  if (Object.keys(env).length === 0) {
    return command;
  }

  switch (shell) {
    case 'Pwsh':
    case 'PowerShell':
      return `${buildPowerShellAssignments(env)}; ${command}`;
    case 'Cmd':
      return `${buildCmdAssignments(env)}${command}`;
    case 'Bash':
    case 'Zsh':
    default:
      return `env ${buildBashAssignments(env)} ${command}`;
  }
}

function buildBaseCommand(profile: LauncherAgentProfile, settings: MidTermSettingsPublic): string {
  if (profile === 'codex') {
    return settings.codexYoloDefault ? 'codex --yolo' : 'codex';
  }

  return settings.claudeDangerouslySkipPermissionsDefault
    ? 'claude --dangerously-skip-permissions'
    : 'claude';
}

function buildPowerShellAssignments(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `$env:${key}='${escapePowerShellString(value)}'`)
    .join('; ');
}

function buildCmdAssignments(env: Record<string, string>): string {
  return (
    Object.entries(env)
      .map(([key, value]) => `set "${key}=${escapeCmdString(value)}"`)
      .join('&& ') + '&& '
  );
}

function buildBashAssignments(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}='${escapeBashString(value)}'`)
    .join(' ');
}

function escapePowerShellString(value: string): string {
  return value.replace(/'/g, "''");
}

function escapeCmdString(value: string): string {
  return value.replace(/"/g, '""');
}

function escapeBashString(value: string): string {
  return value.replace(/'/g, `'"'"'`);
}
