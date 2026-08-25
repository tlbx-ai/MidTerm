let sessionId = new URLSearchParams(location.search).get("perfSession");
const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const nextFrame = () =>
  new Promise((resolve) => requestAnimationFrame(resolve));
const settleFrames = async (count = 4) => {
  for (let frame = 0; frame < count; frame += 1) await nextFrame();
};
const waitFor = async (resolve, timeoutMs = 15000) => {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = resolve();
    if (value) return value;
    await wait(50);
  }
  throw new Error("Timed out waiting for the real ACP history surface.");
};

await waitFor(() => window.mmDebug);
sessionId ??=
  window.mmDebug.activeId ??
  document.querySelector(".session-item[data-session-id]")?.dataset.sessionId ??
  null;
if (!sessionId)
  throw new Error("No ACP session is available for the real-history profile.");
const sessionItem = await waitFor(() =>
  document.querySelector(`.session-item[data-session-id="${sessionId}"]`),
);
sessionItem.click();
await settleFrames(4);
const wrapper = await waitFor(() =>
  document.querySelector(`.session-wrapper[data-session-id="${sessionId}"]`),
);
wrapper.querySelector('.session-tab[data-tab="agent"]')?.click();
const viewport = await waitFor(() => {
  const candidate = wrapper.querySelector('[data-agent-field="history"]');
  return candidate?.clientHeight > 0 ? candidate : null;
});
const navigator = wrapper.querySelector(
  '[data-agent-field="history-progress-nav"]',
);
await waitFor(() =>
  viewport.querySelector("[data-app-server-control-entry-id]"),
);
await settleFrames(8);

const readNavigator = () => ({
  value: Number(navigator?.getAttribute("aria-valuenow") ?? 1),
  maximum: Number(navigator?.getAttribute("aria-valuemax") ?? 1),
});
const findStableAnchor = () => {
  const viewportRect = viewport.getBoundingClientRect();
  const viewportCenter = (viewportRect.top + viewportRect.bottom) / 2;
  return [...viewport.querySelectorAll("[data-app-server-control-entry-id]")]
    .filter((row) => {
      const rect = row.getBoundingClientRect();
      return (
        rect.bottom > viewportRect.top + 8 && rect.top < viewportRect.bottom - 8
      );
    })
    .sort((left, right) => {
      const leftRect = left.getBoundingClientRect();
      const rightRect = right.getBoundingClientRect();
      return (
        Math.abs((leftRect.top + leftRect.bottom) / 2 - viewportCenter) -
        Math.abs((rightRect.top + rightRect.bottom) / 2 - viewportCenter)
      );
    })[0];
};
const sampleStep = async (deltaY) => {
  const anchor = findStableAnchor();
  const anchorId = anchor?.dataset.appServerControlEntryId ?? null;
  const beforeTop = anchor?.getBoundingClientRect().top ?? null;
  const beforeScrollTop = viewport.scrollTop;
  viewport.dispatchEvent(
    new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      composed: true,
      deltaY,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
    }),
  );
  viewport.scrollBy({ top: deltaY, behavior: "instant" });

  const residuals = [];
  for (let frame = 0; frame < 8; frame += 1) {
    await nextFrame();
    if (!anchorId || beforeTop === null) continue;
    const current = viewport.querySelector(
      `[data-app-server-control-entry-id="${CSS.escape(anchorId)}"]`,
    );
    if (!current) continue;
    residuals.push(
      current.getBoundingClientRect().top -
        beforeTop +
        (viewport.scrollTop - beforeScrollTop),
    );
  }
  await wait(8);
  return { ...readNavigator(), residuals };
};

const initial = readNavigator();
const upSamples = [];
for (let step = 0; step < 800 && readNavigator().value > 1; step += 1) {
  upSamples.push(await sampleStep(-220));
}
const top = readNavigator();
const downSamples = [];
for (
  let step = 0;
  step < 800 && readNavigator().value < readNavigator().maximum;
  step += 1
) {
  downSamples.push(await sampleStep(220));
}
const bottom = readNavigator();

const residuals = [...upSamples, ...downSamples].flatMap(
  (sample) => sample.residuals,
);
const absoluteResiduals = residuals
  .map(Math.abs)
  .sort((left, right) => left - right);
const upReversals = upSamples.filter(
  (sample, index) =>
    index > 0 && sample.value > (upSamples[index - 1]?.value ?? sample.value),
).length;
const downReversals = downSamples.filter(
  (sample, index) =>
    index > 0 && sample.value < (downSamples[index - 1]?.value ?? sample.value),
).length;
return {
  sourceScripts: [...document.scripts]
    .map((script) => script.src)
    .filter(Boolean),
  initial,
  top,
  bottom,
  upSteps: upSamples.length,
  downSteps: downSamples.length,
  upReversals,
  downReversals,
  frameSamples: residuals.length,
  maximumAnchorResidualPx: absoluteResiduals.at(-1) ?? null,
  p95AnchorResidualPx:
    absoluteResiduals[Math.floor(absoluteResiduals.length * 0.95)] ?? null,
  renderedRows: viewport.querySelectorAll("[data-app-server-control-entry-id]")
    .length,
};
