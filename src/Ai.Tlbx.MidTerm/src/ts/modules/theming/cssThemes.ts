/**
 * CSS Theme Palettes
 *
 * Complete CSS variable palettes for all UI themes.
 * Applied to :root via style.setProperty() to theme
 * the entire UI chrome (sidebar, settings, buttons, etc).
 */

import type { ThemeName } from '../../types';

type CssThemePalette = Record<string, string>;

const dark: CssThemePalette = {
  '--bg-terminal': '#05050A',
  '--terminal-bg': '#05050A',
  '--bg-primary': '#0D0E14',
  '--bg-elevated': '#161821',
  '--bg-sidebar': '#1C1E2A',
  '--bg-surface': '#242735',
  '--bg-input': '#242735',
  '--bg-dropdown': '#242735',
  '--bg-hover': '#2D3044',
  '--bg-active': '#363A50',
  '--bg-session-hover': '#2D3044',
  '--bg-session-active': '#363A50',
  '--bg-settings': '#161821',
  '--bg-tertiary': '#1C1E2A',

  '--border-color': '#1E202B',
  '--border-default': '#1E202B',
  '--border-subtle': '#282B3A',
  '--border-emphasis': '#3A3E52',

  '--text-primary': '#D4D7E8',
  '--text-terminal': '#E0E2F0',
  '--text-secondary': '#8B8FA6',
  '--text-muted': '#6B7089',

  '--accent-blue': '#7BA2F7',
  '--accent-blue-hover': '#8FB5FF',
  '--accent-cyan': '#7DCFFF',
  '--accent-green': '#8FD694',
  '--accent-orange': '#F5A962',
  '--accent-red': '#F07A8D',
  '--accent-violet': '#9D8CFF',

  '--accent-gold': '#E8B44C',
  '--accent-gold-muted': '#C9A04A',

  '--btn-primary': '#7BA2F7',
  '--btn-primary-hover': '#8FB5FF',
  '--btn-secondary': '#3A3E52',
  '--btn-secondary-hover': '#4A4F68',

  '--bg-success': '#152A20',
  '--border-success': '#2B5A42',
  '--bg-error': '#2A1519',
  '--border-error': '#5A3538',
  '--bg-warning': '#2A2215',
  '--border-warning': '#5A4A2A',
  '--accent-warning': '#E8B44C',

  '--diag-exception': '#F07A8D',
  '--progress-bar': '#7BA2F7',
  '--progress-warning': '#E8B44C',
  '--warning-badge': '#F5A962',

  '--accent-blue-08': 'rgba(123, 162, 247, 0.08)',
  '--accent-blue-10': 'rgba(123, 162, 247, 0.1)',
  '--accent-blue-15': 'rgba(123, 162, 247, 0.15)',
  '--accent-blue-25': 'rgba(123, 162, 247, 0.25)',
  '--accent-blue-40': 'rgba(123, 162, 247, 0.4)',

  '--accent-gold-10': 'rgba(232, 180, 76, 0.1)',
  '--accent-gold-15': 'rgba(232, 180, 76, 0.15)',
  '--accent-gold-25': 'rgba(232, 180, 76, 0.25)',
  '--accent-gold-40': 'rgba(232, 180, 76, 0.4)',

  '--accent-orange-08': 'rgba(245, 169, 98, 0.08)',
  '--accent-orange-10': 'rgba(245, 169, 98, 0.1)',
  '--accent-orange-15': 'rgba(245, 169, 98, 0.15)',

  '--accent-red-10': 'rgba(240, 122, 141, 0.1)',
  '--accent-red-15': 'rgba(240, 122, 141, 0.15)',

  '--accent-green-10': 'rgba(143, 214, 148, 0.1)',
  '--accent-green-15': 'rgba(143, 214, 148, 0.15)',

  '--accent-purple': '#9D8CFF',

  '--tool-yellow-bg': 'rgba(232, 180, 76, 0.1)',
  '--tool-yellow-border': 'rgba(232, 180, 76, 0.2)',
  '--tool-yellow-border-strong': 'rgba(232, 180, 76, 0.3)',
  '--tool-yellow-border-emphasis': 'rgba(232, 180, 76, 0.4)',
  '--tool-yellow-gradient':
    'linear-gradient(135deg, rgba(232, 180, 76, 0.15), rgba(201, 160, 74, 0.15))',
  '--tool-purple-bg': 'rgba(157, 140, 255, 0.08)',
  '--tool-purple-bg-light': 'rgba(157, 140, 255, 0.12)',
  '--tool-purple-border': 'rgba(157, 140, 255, 0.15)',
  '--tool-purple-border-strong': 'rgba(157, 140, 255, 0.35)',
  '--tool-purple-gradient':
    'linear-gradient(135deg, rgba(157, 140, 255, 0.12), rgba(123, 162, 247, 0.12))',

  '--shadow-color': 'rgba(0, 0, 0, 0.3)',
  '--shadow-color-md': 'rgba(0, 0, 0, 0.4)',
  '--shadow-color-lg': 'rgba(0, 0, 0, 0.5)',
  '--overlay-bg': 'rgba(0, 0, 0, 0.6)',
  '--overlay-bg-dark': 'rgba(0, 0, 0, 0.7)',

  '--white-03': 'rgba(255, 255, 255, 0.03)',
  '--white-60': 'rgba(255, 255, 255, 0.6)',
};

const light: CssThemePalette = {
  '--bg-terminal': '#D5D6DB',
  '--terminal-bg': '#D5D6DB',
  '--bg-primary': '#F0F1F4',
  '--bg-elevated': '#FFFFFF',
  '--bg-sidebar': '#E8E9ED',
  '--bg-surface': '#FFFFFF',
  '--bg-input': '#FFFFFF',
  '--bg-dropdown': '#FFFFFF',
  '--bg-hover': '#E2E3E8',
  '--bg-active': '#D5D7DE',
  '--bg-session-hover': '#E2E3E8',
  '--bg-session-active': '#D5D7DE',
  '--bg-settings': '#FFFFFF',
  '--bg-tertiary': '#E8E9ED',

  '--border-color': '#D0D2DA',
  '--border-default': '#D0D2DA',
  '--border-subtle': '#E0E1E6',
  '--border-emphasis': '#B8BBCA',

  '--text-primary': '#24292F',
  '--text-terminal': '#343B58',
  '--text-secondary': '#57606A',
  '--text-muted': '#8B949E',

  '--accent-blue': '#2563EB',
  '--accent-blue-hover': '#1D4ED8',
  '--accent-cyan': '#0891B2',
  '--accent-green': '#16A34A',
  '--accent-orange': '#D97706',
  '--accent-red': '#DC2626',
  '--accent-violet': '#7C3AED',

  '--accent-gold': '#B45309',
  '--accent-gold-muted': '#92400E',

  '--btn-primary': '#2563EB',
  '--btn-primary-hover': '#1D4ED8',
  '--btn-secondary': '#D0D2DA',
  '--btn-secondary-hover': '#B8BBCA',

  '--bg-success': '#DCFCE7',
  '--border-success': '#86EFAC',
  '--bg-error': '#FEE2E2',
  '--border-error': '#FCA5A5',
  '--bg-warning': '#FEF3C7',
  '--border-warning': '#FCD34D',
  '--accent-warning': '#D97706',

  '--diag-exception': '#DC2626',
  '--progress-bar': '#2563EB',
  '--progress-warning': '#D97706',
  '--warning-badge': '#D97706',

  '--accent-blue-08': 'rgba(37, 99, 235, 0.08)',
  '--accent-blue-10': 'rgba(37, 99, 235, 0.1)',
  '--accent-blue-15': 'rgba(37, 99, 235, 0.15)',
  '--accent-blue-25': 'rgba(37, 99, 235, 0.25)',
  '--accent-blue-40': 'rgba(37, 99, 235, 0.4)',

  '--accent-gold-10': 'rgba(180, 83, 9, 0.1)',
  '--accent-gold-15': 'rgba(180, 83, 9, 0.15)',
  '--accent-gold-25': 'rgba(180, 83, 9, 0.25)',
  '--accent-gold-40': 'rgba(180, 83, 9, 0.4)',

  '--accent-orange-08': 'rgba(217, 119, 6, 0.08)',
  '--accent-orange-10': 'rgba(217, 119, 6, 0.1)',
  '--accent-orange-15': 'rgba(217, 119, 6, 0.15)',

  '--accent-red-10': 'rgba(220, 38, 38, 0.1)',
  '--accent-red-15': 'rgba(220, 38, 38, 0.15)',

  '--accent-green-10': 'rgba(22, 163, 74, 0.1)',
  '--accent-green-15': 'rgba(22, 163, 74, 0.15)',

  '--accent-purple': '#7C3AED',

  '--tool-yellow-bg': 'rgba(180, 83, 9, 0.1)',
  '--tool-yellow-border': 'rgba(180, 83, 9, 0.2)',
  '--tool-yellow-border-strong': 'rgba(180, 83, 9, 0.3)',
  '--tool-yellow-border-emphasis': 'rgba(180, 83, 9, 0.4)',
  '--tool-yellow-gradient':
    'linear-gradient(135deg, rgba(180, 83, 9, 0.1), rgba(146, 64, 14, 0.1))',
  '--tool-purple-bg': 'rgba(124, 58, 237, 0.08)',
  '--tool-purple-bg-light': 'rgba(124, 58, 237, 0.12)',
  '--tool-purple-border': 'rgba(124, 58, 237, 0.15)',
  '--tool-purple-border-strong': 'rgba(124, 58, 237, 0.35)',
  '--tool-purple-gradient':
    'linear-gradient(135deg, rgba(124, 58, 237, 0.1), rgba(37, 99, 235, 0.1))',

  '--shadow-color': 'rgba(0, 0, 0, 0.08)',
  '--shadow-color-md': 'rgba(0, 0, 0, 0.12)',
  '--shadow-color-lg': 'rgba(0, 0, 0, 0.18)',
  '--overlay-bg': 'rgba(0, 0, 0, 0.3)',
  '--overlay-bg-dark': 'rgba(0, 0, 0, 0.4)',

  '--white-03': 'rgba(0, 0, 0, 0.03)',
  '--white-60': 'rgba(0, 0, 0, 0.45)',
};

const solarizedDark: CssThemePalette = {
  '--bg-terminal': '#002B36',
  '--terminal-bg': '#002B36',
  '--bg-primary': '#002B36',
  '--bg-elevated': '#073642',
  '--bg-sidebar': '#073642',
  '--bg-surface': '#0A3F4C',
  '--bg-input': '#0A3F4C',
  '--bg-dropdown': '#0A3F4C',
  '--bg-hover': '#0D4A58',
  '--bg-active': '#115564',
  '--bg-session-hover': '#0D4A58',
  '--bg-session-active': '#115564',
  '--bg-settings': '#073642',
  '--bg-tertiary': '#073642',

  '--border-color': '#0D4A58',
  '--border-default': '#0D4A58',
  '--border-subtle': '#0A3F4C',
  '--border-emphasis': '#2D7A8A',

  '--text-primary': '#93A1A1',
  '--text-terminal': '#839496',
  '--text-secondary': '#657B83',
  '--text-muted': '#586E75',

  '--accent-blue': '#268BD2',
  '--accent-blue-hover': '#3A9BE0',
  '--accent-cyan': '#2AA198',
  '--accent-green': '#859900',
  '--accent-orange': '#CB4B16',
  '--accent-red': '#DC322F',
  '--accent-violet': '#6C71C4',

  '--accent-gold': '#B58900',
  '--accent-gold-muted': '#9A7500',

  '--btn-primary': '#268BD2',
  '--btn-primary-hover': '#3A9BE0',
  '--btn-secondary': '#0D4A58',
  '--btn-secondary-hover': '#115564',

  '--bg-success': '#0A2E1A',
  '--border-success': '#1A5A35',
  '--bg-error': '#2A0E0E',
  '--border-error': '#5A2525',
  '--bg-warning': '#2A2005',
  '--border-warning': '#5A4510',
  '--accent-warning': '#B58900',

  '--diag-exception': '#DC322F',
  '--progress-bar': '#268BD2',
  '--progress-warning': '#B58900',
  '--warning-badge': '#CB4B16',

  '--accent-blue-08': 'rgba(38, 139, 210, 0.08)',
  '--accent-blue-10': 'rgba(38, 139, 210, 0.1)',
  '--accent-blue-15': 'rgba(38, 139, 210, 0.15)',
  '--accent-blue-25': 'rgba(38, 139, 210, 0.25)',
  '--accent-blue-40': 'rgba(38, 139, 210, 0.4)',

  '--accent-gold-10': 'rgba(181, 137, 0, 0.1)',
  '--accent-gold-15': 'rgba(181, 137, 0, 0.15)',
  '--accent-gold-25': 'rgba(181, 137, 0, 0.25)',
  '--accent-gold-40': 'rgba(181, 137, 0, 0.4)',

  '--accent-orange-08': 'rgba(203, 75, 22, 0.08)',
  '--accent-orange-10': 'rgba(203, 75, 22, 0.1)',
  '--accent-orange-15': 'rgba(203, 75, 22, 0.15)',

  '--accent-red-10': 'rgba(220, 50, 47, 0.1)',
  '--accent-red-15': 'rgba(220, 50, 47, 0.15)',

  '--accent-green-10': 'rgba(133, 153, 0, 0.1)',
  '--accent-green-15': 'rgba(133, 153, 0, 0.15)',

  '--accent-purple': '#6C71C4',

  '--tool-yellow-bg': 'rgba(181, 137, 0, 0.1)',
  '--tool-yellow-border': 'rgba(181, 137, 0, 0.2)',
  '--tool-yellow-border-strong': 'rgba(181, 137, 0, 0.3)',
  '--tool-yellow-border-emphasis': 'rgba(181, 137, 0, 0.4)',
  '--tool-yellow-gradient':
    'linear-gradient(135deg, rgba(181, 137, 0, 0.15), rgba(154, 117, 0, 0.15))',
  '--tool-purple-bg': 'rgba(108, 113, 196, 0.08)',
  '--tool-purple-bg-light': 'rgba(108, 113, 196, 0.12)',
  '--tool-purple-border': 'rgba(108, 113, 196, 0.15)',
  '--tool-purple-border-strong': 'rgba(108, 113, 196, 0.35)',
  '--tool-purple-gradient':
    'linear-gradient(135deg, rgba(108, 113, 196, 0.12), rgba(38, 139, 210, 0.12))',

  '--shadow-color': 'rgba(0, 0, 0, 0.3)',
  '--shadow-color-md': 'rgba(0, 0, 0, 0.4)',
  '--shadow-color-lg': 'rgba(0, 0, 0, 0.5)',
  '--overlay-bg': 'rgba(0, 0, 0, 0.6)',
  '--overlay-bg-dark': 'rgba(0, 0, 0, 0.7)',

  '--white-03': 'rgba(255, 255, 255, 0.03)',
  '--white-60': 'rgba(255, 255, 255, 0.6)',
};

const solarizedLight: CssThemePalette = {
  '--bg-terminal': '#FDF6E3',
  '--terminal-bg': '#FDF6E3',
  '--bg-primary': '#FDF6E3',
  '--bg-elevated': '#EEE8D5',
  '--bg-sidebar': '#EEE8D5',
  '--bg-surface': '#E6DFC8',
  '--bg-input': '#E6DFC8',
  '--bg-dropdown': '#E6DFC8',
  '--bg-hover': '#DDD6C1',
  '--bg-active': '#D3CCB7',
  '--bg-session-hover': '#DDD6C1',
  '--bg-session-active': '#D3CCB7',
  '--bg-settings': '#EEE8D5',
  '--bg-tertiary': '#EEE8D5',

  '--border-color': '#D3CCB7',
  '--border-default': '#D3CCB7',
  '--border-subtle': '#DDD6C1',
  '--border-emphasis': '#B8B2A0',

  '--text-primary': '#586E75',
  '--text-terminal': '#657B83',
  '--text-secondary': '#657B83',
  '--text-muted': '#93A1A1',

  '--accent-blue': '#268BD2',
  '--accent-blue-hover': '#1A7ABD',
  '--accent-cyan': '#2AA198',
  '--accent-green': '#859900',
  '--accent-orange': '#CB4B16',
  '--accent-red': '#DC322F',
  '--accent-violet': '#6C71C4',

  '--accent-gold': '#B58900',
  '--accent-gold-muted': '#9A7500',

  '--btn-primary': '#268BD2',
  '--btn-primary-hover': '#1A7ABD',
  '--btn-secondary': '#D3CCB7',
  '--btn-secondary-hover': '#C5BDA8',

  '--bg-success': '#E6F2E6',
  '--border-success': '#A8D8A8',
  '--bg-error': '#FCE4E4',
  '--border-error': '#F0AAAA',
  '--bg-warning': '#FDF2D0',
  '--border-warning': '#E8D48A',
  '--accent-warning': '#B58900',

  '--diag-exception': '#DC322F',
  '--progress-bar': '#268BD2',
  '--progress-warning': '#B58900',
  '--warning-badge': '#CB4B16',

  '--accent-blue-08': 'rgba(38, 139, 210, 0.08)',
  '--accent-blue-10': 'rgba(38, 139, 210, 0.1)',
  '--accent-blue-15': 'rgba(38, 139, 210, 0.15)',
  '--accent-blue-25': 'rgba(38, 139, 210, 0.25)',
  '--accent-blue-40': 'rgba(38, 139, 210, 0.4)',

  '--accent-gold-10': 'rgba(181, 137, 0, 0.1)',
  '--accent-gold-15': 'rgba(181, 137, 0, 0.15)',
  '--accent-gold-25': 'rgba(181, 137, 0, 0.25)',
  '--accent-gold-40': 'rgba(181, 137, 0, 0.4)',

  '--accent-orange-08': 'rgba(203, 75, 22, 0.08)',
  '--accent-orange-10': 'rgba(203, 75, 22, 0.1)',
  '--accent-orange-15': 'rgba(203, 75, 22, 0.15)',

  '--accent-red-10': 'rgba(220, 50, 47, 0.1)',
  '--accent-red-15': 'rgba(220, 50, 47, 0.15)',

  '--accent-green-10': 'rgba(133, 153, 0, 0.1)',
  '--accent-green-15': 'rgba(133, 153, 0, 0.15)',

  '--accent-purple': '#6C71C4',

  '--tool-yellow-bg': 'rgba(181, 137, 0, 0.1)',
  '--tool-yellow-border': 'rgba(181, 137, 0, 0.2)',
  '--tool-yellow-border-strong': 'rgba(181, 137, 0, 0.3)',
  '--tool-yellow-border-emphasis': 'rgba(181, 137, 0, 0.4)',
  '--tool-yellow-gradient':
    'linear-gradient(135deg, rgba(181, 137, 0, 0.1), rgba(154, 117, 0, 0.1))',
  '--tool-purple-bg': 'rgba(108, 113, 196, 0.08)',
  '--tool-purple-bg-light': 'rgba(108, 113, 196, 0.12)',
  '--tool-purple-border': 'rgba(108, 113, 196, 0.15)',
  '--tool-purple-border-strong': 'rgba(108, 113, 196, 0.35)',
  '--tool-purple-gradient':
    'linear-gradient(135deg, rgba(108, 113, 196, 0.1), rgba(38, 139, 210, 0.1))',

  '--shadow-color': 'rgba(0, 0, 0, 0.06)',
  '--shadow-color-md': 'rgba(0, 0, 0, 0.1)',
  '--shadow-color-lg': 'rgba(0, 0, 0, 0.15)',
  '--overlay-bg': 'rgba(0, 0, 0, 0.3)',
  '--overlay-bg-dark': 'rgba(0, 0, 0, 0.4)',

  '--white-03': 'rgba(0, 0, 0, 0.03)',
  '--white-60': 'rgba(0, 0, 0, 0.45)',
};

export const CSS_THEMES: Record<ThemeName, CssThemePalette> = {
  dark,
  light,
  solarizedDark,
  solarizedLight,
};

export function applyCssTheme(themeName: ThemeName): void {
  const palette = CSS_THEMES[themeName] || CSS_THEMES.dark;
  const root = document.documentElement;
  for (const [prop, value] of Object.entries(palette)) {
    root.style.setProperty(prop, value);
  }
}
