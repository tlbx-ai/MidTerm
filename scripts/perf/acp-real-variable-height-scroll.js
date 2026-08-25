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
  const beforeNavigator = readNavigator();
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
        deltaY,
    );
  }
  await wait(8);
  return {
    ...readNavigator(),
    beforeValue: beforeNavigator.value,
    anchorId,
    beforeScrollTop,
    afterScrollTop: viewport.scrollTop,
    residuals,
  };
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
const finalAbsoluteResiduals = [...upSamples, ...downSamples]
  .map((sample) => Math.abs(sample.residuals.at(-1) ?? 0))
  .sort((left, right) => left - right);
const settlingReversals = [...upSamples, ...downSamples].reduce(
  (total, sample) =>
    total +
    sample.residuals.reduce((reversals, residual, index, values) => {
      if (index === 0) return reversals;
      return reversals +
        (Math.abs(residual) > Math.abs(values[index - 1]) + 1 ? 1 : 0);
    }, 0),
  0,
);
const outliers = [...upSamples.map((sample) => ({ direction: 'up', ...sample })),
  ...downSamples.map((sample) => ({ direction: 'down', ...sample }))]
  .map((sample) => ({
    direction: sample.direction,
    beforeValue: sample.beforeValue,
    value: sample.value,
    anchorId: sample.anchorId,
    beforeScrollTop: sample.beforeScrollTop,
    afterScrollTop: sample.afterScrollTop,
    maximumResidualPx: Math.max(0, ...sample.residuals.map(Math.abs)),
  }))
  .filter((sample) => sample.maximumResidualPx > 8)
  .sort((left, right) => right.maximumResidualPx - left.maximumResidualPx)
  .slice(0, 20);
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
  maximumSettledAnchorResidualPx: finalAbsoluteResiduals.at(-1) ?? null,
  p95SettledAnchorResidualPx:
    finalAbsoluteResiduals[Math.floor(finalAbsoluteResiduals.length * 0.95)] ?? null,
  settlingReversals,
  residualsOver8Px: absoluteResiduals.filter((value) => value > 8).length,
  residualsOver100Px: absoluteResiduals.filter((value) => value > 100).length,
  outliers,
  renderedRows: viewport.querySelectorAll("[data-app-server-control-entry-id]")
    .length,
};
