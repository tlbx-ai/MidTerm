import { describe, expect, it } from 'vitest';
import { CSS_THEMES } from './cssThemes';

const requiredCtaTokens = [
  '--cta-primary',
  '--cta-primary-muted',
  '--cta-primary-text',
  '--cta-primary-25',
  '--cta-primary-40',
] as const;

describe('CSS_THEMES CTA tokens', () => {
  it('defines CTA tokens for every theme palette', () => {
    for (const [themeName, palette] of Object.entries(CSS_THEMES)) {
      for (const token of requiredCtaTokens) {
        expect(
          palette[token],
          `Missing token ${token} in theme ${themeName}`,
        ).toBeTruthy();
      }
    }
  });

  it('uses blue CTA tokens in light theme for better contrast', () => {
    const light = CSS_THEMES.light;
    expect(light['--cta-primary']).toBe('#2563EB');
    expect(light['--cta-primary-muted']).toBe('#1D4ED8');
    expect(light['--cta-primary-text']).toBe('#FFFFFF');
    expect(light['--cta-primary-25']).toBe('rgba(37, 99, 235, 0.25)');
    expect(light['--cta-primary-40']).toBe('rgba(37, 99, 235, 0.4)');
  });

  it('keeps non-light themes aligned with their existing gold CTA treatment', () => {
    expect(CSS_THEMES.dark['--cta-primary']).toBe(CSS_THEMES.dark['--accent-gold']);
    expect(CSS_THEMES.solarizedDark['--cta-primary']).toBe(
      CSS_THEMES.solarizedDark['--accent-gold'],
    );
    expect(CSS_THEMES.solarizedLight['--cta-primary']).toBe(
      CSS_THEMES.solarizedLight['--accent-gold'],
    );
  });
});
