const waitFor = async (predicate, timeoutMs = 10000, label = 'desktop Command Bay') => {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}.`);
};

const sessionItem = await waitFor(
  () => document.querySelector('.session-item[data-session-id]'),
  10000,
  'a session item',
);
sessionItem.click();
const dock = await waitFor(() => {
  const candidate = document.querySelector('.adaptive-footer-dock[data-device="desktop"]');
  return candidate && !candidate.hidden ? candidate : null;
});
await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

const selectors = [
  '.adaptive-footer-dock',
  '.adaptive-footer-primary',
  '.smart-input-row',
  '.smart-input-textarea',
  '.smart-input-send-btn',
  '.smart-input-tools-toggle',
];

const snapshot = Object.fromEntries(
  selectors.map((selector) => {
    const element = document.querySelector(selector);
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return [
      selector,
      {
        width: rect.width,
        height: rect.height,
        display: style.display,
        position: style.position,
        padding: style.padding,
        margin: style.margin,
        gap: style.gap,
        border: style.border,
        borderRadius: style.borderRadius,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
      },
    ];
  }),
);

return {
  viewport: { width: innerWidth, height: innerHeight },
  device: dock.dataset.device,
  controlHeight: getComputedStyle(dock).getPropertyValue('--command-bay-control-height').trim(),
  gap: getComputedStyle(dock).getPropertyValue('--command-bay-gap').trim(),
  snapshot,
};
