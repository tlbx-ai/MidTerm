import { dom } from '../../state';
import { $isMainBrowser } from '../../stores';
import { getConfiguredTerminalFontFamily } from './fontConfig';
import { getEffectiveTerminalFontSize } from './fontSize';
import { calculateOptimalDimensions } from './scaling';

interface LaunchSizingSettings {
  defaultCols?: number;
  defaultRows?: number;
  fontSize?: number;
  lineHeight?: number;
  letterSpacing?: number;
  fontWeight?: string;
  fontWeightBold?: string;
}

export async function resolveLaunchDimensions(
  settings: LaunchSizingSettings | null | undefined,
  logPrefix: string,
): Promise<{ cols: number; rows: number }> {
  const defaultCols = settings?.defaultCols ?? 120;
  const defaultRows = settings?.defaultRows ?? 30;

  if (!$isMainBrowser.get()) {
    return { cols: defaultCols, rows: defaultRows };
  }

  if (!dom.terminalsArea) {
    return { cols: defaultCols, rows: defaultRows };
  }

  const dims = await calculateOptimalDimensions(
    dom.terminalsArea,
    getEffectiveTerminalFontSize(settings?.fontSize ?? 14),
    getConfiguredTerminalFontFamily(),
    settings?.lineHeight ?? 1,
    settings?.letterSpacing ?? 0,
    settings?.fontWeight ?? 'normal',
    settings?.fontWeightBold ?? 'bold',
    `${logPrefix}-${crypto.randomUUID().slice(0, 8)}`,
  );

  return dims ?? { cols: defaultCols, rows: defaultRows };
}
