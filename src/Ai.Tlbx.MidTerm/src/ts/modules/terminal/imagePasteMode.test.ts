import { describe, expect, it } from 'vitest';
import { resolveImagePasteMode } from './imagePasteMode';

describe('resolveImagePasteMode', () => {
  it('uses native mode for known clipboard-native agents', () => {
    expect(resolveImagePasteMode({ name: 'codex', commandLine: null })).toBe('native');
    expect(resolveImagePasteMode({ name: 'node', commandLine: 'npx claude-code' })).toBe(
      'native',
    );
    expect(resolveImagePasteMode({ name: 'python', commandLine: 'aider --model sonnet' })).toBe(
      'native',
    );
  });

  it('uses path mode for unknown tools', () => {
    expect(resolveImagePasteMode({ name: 'bash', commandLine: '/usr/bin/bash' })).toBe('path');
    expect(resolveImagePasteMode({ name: 'cursor-agent', commandLine: 'cursor-agent run' })).toBe(
      'path',
    );
  });

  it('is case-insensitive', () => {
    expect(resolveImagePasteMode({ name: 'CoDeX', commandLine: null })).toBe('native');
    expect(resolveImagePasteMode({ name: null, commandLine: 'NPX GEMINI' })).toBe('native');
  });
});

