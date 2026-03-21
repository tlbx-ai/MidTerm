import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MidTermSettingsPublic } from '../../api/types';
import { applyBackgroundAppearance } from './backgroundAppearance';

class MockStyle {
  private readonly values = new Map<string, string>();

  public setProperty(name: string, value: string): void {
    this.values.set(name, value);
  }

  public getPropertyValue(name: string): string {
    return this.values.get(name) ?? '';
  }
}

class MockClassList {
  private readonly values = new Set<string>();

  public toggle(name: string, force?: boolean): boolean {
    if (force === true) {
      this.values.add(name);
      return true;
    }

    if (force === false) {
      this.values.delete(name);
      return false;
    }

    if (this.values.has(name)) {
      this.values.delete(name);
      return false;
    }

    this.values.add(name);
    return true;
  }

  public contains(name: string): boolean {
    return this.values.has(name);
  }
}

const originalDocument = globalThis.document;

function createSettings(
  partial: Partial<
    Pick<
      MidTermSettingsPublic,
      | 'theme'
      | 'uiTransparency'
      | 'terminalTransparency'
      | 'backgroundImageEnabled'
      | 'backgroundImageFileName'
      | 'backgroundImageRevision'
      | 'backgroundImageFit'
    >
  >,
): MidTermSettingsPublic {
  return {
    theme: 'dark',
    uiTransparency: 0,
    terminalTransparency: 0,
    backgroundImageEnabled: false,
    backgroundImageFileName: null,
    backgroundImageRevision: 0,
    backgroundImageFit: 'cover',
    ...partial,
  } as MidTermSettingsPublic;
}

function alphaOf(value: string): number {
  const match = value.match(/,\s*([0-9.]+)\)$/);
  if (!match || !match[1]) {
    throw new Error(`Could not extract alpha from "${value}"`);
  }

  return Number.parseFloat(match[1]);
}

let rootStyle: MockStyle;
let bodyClassList: MockClassList;

beforeEach(() => {
  rootStyle = new MockStyle();
  bodyClassList = new MockClassList();

  Object.defineProperty(globalThis, 'document', {
    value: {
      documentElement: { style: rootStyle },
      body: { classList: bodyClassList },
    },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  Object.defineProperty(globalThis, 'document', {
    value: originalDocument,
    configurable: true,
    writable: true,
  });
});

describe('backgroundAppearance', () => {
  it('keeps terminal chrome tokens stable while UI transparency affects surrounding UI', () => {
    applyBackgroundAppearance(
      createSettings({
        theme: 'dark',
        uiTransparency: 30,
        terminalTransparency: 60,
      }),
    );

    const primaryAlpha = alphaOf(rootStyle.getPropertyValue('--bg-primary'));
    const elevatedAlpha = alphaOf(rootStyle.getPropertyValue('--bg-elevated'));
    const dropdownAlpha = alphaOf(rootStyle.getPropertyValue('--bg-dropdown'));

    expect(rootStyle.getPropertyValue('--bg-terminal')).toBe('');
    expect(rootStyle.getPropertyValue('--terminal-bg')).toBe('');
    expect(primaryAlpha).toBeCloseTo(0.86, 5);
    expect(elevatedAlpha).toBeGreaterThan(primaryAlpha);
    expect(dropdownAlpha).toBeGreaterThan(elevatedAlpha);
    expect(rootStyle.getPropertyValue('--bg-primary-opaque')).toBe('#0D0E14');
    expect(rootStyle.getPropertyValue('--bg-settings-opaque')).toBe('#161821');
    expect(rootStyle.getPropertyValue('--bg-hover-opaque')).toBe('#2D3044');
    expect(rootStyle.getPropertyValue('--bg-active-opaque')).toBe('#363A50');
    expect(rootStyle.getPropertyValue('--bg-dropdown-opaque')).toBe('#242735');
    expect(rootStyle.getPropertyValue('--bg-elevated-opaque')).toBe('#161821');
  });

  it('publishes wallpaper metadata and keeps popup shells opaque for the selected theme', () => {
    applyBackgroundAppearance(
      createSettings({
        theme: 'light',
        uiTransparency: 35,
        terminalTransparency: 55,
        backgroundImageEnabled: true,
        backgroundImageFileName: 'paper.jpg',
        backgroundImageRevision: 12,
        backgroundImageFit: 'contain',
      }),
    );

    expect(rootStyle.getPropertyValue('--app-background-image')).toBe(
      'url("/api/settings/background-image?v=12")',
    );
    expect(rootStyle.getPropertyValue('--app-background-size')).toBe('contain');
    expect(rootStyle.getPropertyValue('--bg-primary-opaque')).toBe('#EAE2D8');
    expect(rootStyle.getPropertyValue('--bg-settings-opaque')).toBe('#FEFCF9');
    expect(rootStyle.getPropertyValue('--bg-elevated-opaque')).toBe('#FEFCF9');
    expect(rootStyle.getPropertyValue('--bg-dropdown-opaque')).toBe('#FEFCF9');
    expect(rootStyle.getPropertyValue('--bg-terminal')).toBe('');
    expect(bodyClassList.contains('has-app-background')).toBe(true);
  });

  it('allows the UI transparency slider to reach a fully transparent UI shell', () => {
    applyBackgroundAppearance(
      createSettings({
        theme: 'dark',
        uiTransparency: 100,
      }),
    );

    expect(rootStyle.getPropertyValue('--bg-primary')).toBe('rgba(13, 14, 20, 0.160)');
    expect(rootStyle.getPropertyValue('--bg-terminal')).toBe('');
  });
});
