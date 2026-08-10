const waitFor = async (predicate, timeoutMs = 10000, label = 'mobile Command Bay') => {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}.`);
};

const settle = () =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 1 });
if (!('ontouchstart' in window)) {
  Object.defineProperty(window, 'ontouchstart', { configurable: true, value: null });
}
const nativeMatchMedia = window.matchMedia.bind(window);
window.matchMedia = (query) => {
  if (query.includes('pointer: fine') || query.includes('hover: hover')) {
    return {
      matches: false,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent() {
        return true;
      },
    };
  }
  return nativeMatchMedia(query);
};
window.dispatchEvent(new Event('resize'));

const sessionItem = await waitFor(
  () => document.querySelector('.session-item[data-session-id]'),
  10000,
  'a session item',
);
sessionItem.click();

const dock = await waitFor(() => {
  const candidate = document.querySelector('.adaptive-footer-dock[data-device="mobile"]');
  return candidate && !candidate.hidden ? candidate : null;
}, 10000, 'the mobile footer');
const toolsToggle = await waitFor(
  () => document.querySelector('.smart-input-tools-toggle'),
  10000,
  'the tools toggle',
);
await settle();

const readRect = (selector) => {
  const element = document.querySelector(selector);
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return {
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    left: rect.left,
    width: rect.width,
    height: rect.height,
  };
};

const snapshot = () => ({
  dock: readRect('.adaptive-footer-dock'),
  primary: readRect('.adaptive-footer-primary'),
  reserve: readRect('.adaptive-footer-reserve'),
  xterm: readRect('.session-wrapper.active .xterm, .session-wrapper:not(.hidden) .xterm'),
  reservedHeight: getComputedStyle(document.documentElement)
    .getPropertyValue('--adaptive-footer-reserved-height')
    .trim(),
  statusHidden: document.querySelector('.adaptive-footer-status')?.hidden ?? null,
  toolLabels: [...document.querySelectorAll('.smart-input-tools-surface .smart-input-tool-label')]
    .map((element) => element.textContent?.trim())
    .filter(Boolean),
  toolsOpen: toolsToggle.getAttribute('aria-expanded'),
});

const before = snapshot();
toolsToggle.click();
await settle();
const toolsOpen = snapshot();

const keysToggle = await waitFor(() =>
  document.querySelector('.smart-input-mobile-touch-toggle'),
  10000,
  'the mobile touch keys toggle',
);
keysToggle.click();
await settle();
const keysOpen = snapshot();

const stableGeometry = (left, right) =>
  left.reservedHeight === right.reservedHeight &&
  left.dock?.height === right.dock?.height &&
  left.primary?.height === right.primary?.height &&
  left.xterm?.height === right.xterm?.height;

return {
  viewport: { width: innerWidth, height: innerHeight },
  before,
  toolsOpen,
  keysOpen,
  stableWhenToolsOpen: stableGeometry(before, toolsOpen),
  stableWhenKeysOpen: stableGeometry(before, keysOpen),
  requiredToolsPresent: [
    'Push to talk',
    'Attach file',
    'Take photo',
    'Show keys',
    'More automations',
    'Add automation',
  ].every((label) => toolsOpen.toolLabels.includes(label)),
  touchControllerVisible:
    document.querySelector('.smart-input-mobile-touch-host .touch-controller.visible') !== null,
};
