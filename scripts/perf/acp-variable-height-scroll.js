let sessionId = new URLSearchParams(location.search).get("perfSession");
const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const nextFrame = () =>
  new Promise((resolve) => requestAnimationFrame(resolve));
const settleFrames = async (count = 4) => {
  for (let frame = 0; frame < count; frame += 1) await nextFrame();
};
const waitFor = async (resolve, timeoutMs = 10000) => {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = resolve();
    if (value) return value;
    await wait(50);
  }
  throw new Error("Timed out waiting for the ACP variable-height scenario.");
};

await waitFor(() => window.mmDebug?.appServerControl);
sessionId ??=
  window.mmDebug.activeId ??
  document.querySelector(".session-item[data-session-id]")?.dataset.sessionId ??
  null;
if (!sessionId)
  throw new Error("No session is available for the ACP debug scenario.");
await window.mmDebug.appServerControl.showScenario(sessionId, "massive");
const wrapper = await waitFor(() =>
  document.querySelector(`.session-wrapper[data-session-id="${sessionId}"]`),
);
const panel = wrapper.querySelector(".agent-tab-panel");
const viewport = wrapper.querySelector('[data-agent-field="history"]');
wrapper.style.cssText =
  "display:flex;position:fixed;inset:0;z-index:99999;width:1600px;height:900px;background:#111";
panel.style.cssText = "display:flex;flex:1;min-height:0";
viewport.style.cssText +=
  ";display:flex;flex:1;min-height:0;height:800px;overflow-y:auto";
await settleFrames(6);

const findStableAnchor = () => {
  const viewportRect = viewport.getBoundingClientRect();
  const intersecting = [
    ...viewport.querySelectorAll("[data-app-server-control-entry-id]"),
  ].filter((row) => {
    const rect = row.getBoundingClientRect();
    return (
      rect.bottom > viewportRect.top + 8 && rect.top < viewportRect.bottom - 8
    );
  });
  const viewportCenter = (viewportRect.top + viewportRect.bottom) / 2;
  return intersecting.sort((left, right) => {
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
  for (let frame = 0; frame < 6; frame += 1) {
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

  return {
    anchorId,
    residuals,
    scrollTop: viewport.scrollTop,
    scrollHeight: viewport.scrollHeight,
  };
};

viewport.scrollTop = 0;
await settleFrames(8);
const samples = [];
for (let step = 0; step < 120; step += 1) samples.push(await sampleStep(160));
for (let step = 0; step < 120; step += 1) samples.push(await sampleStep(-160));

const residuals = samples.flatMap((sample) => sample.residuals);
const absoluteResiduals = residuals.map(Math.abs);
const renderedRows = viewport.querySelectorAll(
  "[data-app-server-control-entry-id]",
).length;
return {
  sampleCount: samples.length,
  frameSamples: residuals.length,
  maximumAnchorResidualPx: absoluteResiduals.length
    ? Math.max(...absoluteResiduals)
    : null,
  p95AnchorResidualPx: absoluteResiduals.length
    ? [...absoluteResiduals].sort((left, right) => left - right)[
        Math.floor(absoluteResiduals.length * 0.95)
      ]
    : null,
  finalScrollTop: viewport.scrollTop,
  finalScrollHeight: viewport.scrollHeight,
  renderedRows,
  viewportRect: viewport.getBoundingClientRect().toJSON(),
  rowRects: [...viewport.querySelectorAll("[data-app-server-control-entry-id]")]
    .slice(0, 4)
    .map((row) => row.getBoundingClientRect().toJSON()),
};
