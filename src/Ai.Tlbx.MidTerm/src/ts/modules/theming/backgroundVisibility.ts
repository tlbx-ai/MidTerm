import type { MidTermSettingsPublic } from '../../types';
import { MOBILE_BREAKPOINT } from '../../constants';

export function isMobileBackgroundSuppressed(
  settings: Pick<MidTermSettingsPublic, 'hideBackgroundImageOnMobile'> | null | undefined,
): boolean {
  return Boolean(settings?.hideBackgroundImageOnMobile) && isMobilePresentationContext();
}

export function shouldRenderBackgroundImage(
  settings:
    | Pick<
        MidTermSettingsPublic,
        | 'backgroundImageEnabled'
        | 'backgroundImageFileName'
        | 'backgroundImageRevision'
        | 'hideBackgroundImageOnMobile'
      >
    | null
    | undefined,
): boolean {
  return Boolean(
    settings?.backgroundImageEnabled &&
    settings.backgroundImageFileName &&
    settings.backgroundImageRevision > 0 &&
    !isMobileBackgroundSuppressed(settings),
  );
}

function isMobilePresentationContext(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  return (
    window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`).matches || navigator.maxTouchPoints > 0
  );
}
