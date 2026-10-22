/** Isolate PDF rendering and its worker from the terminal's document/lifecycle. */
export function createPdfView(
  viewUrl: string,
  className: string,
  signal?: AbortSignal,
): HTMLIFrameElement {
  const frame = document.createElement('iframe');
  frame.className = className;
  frame.title = 'PDF';
  const params = new URLSearchParams({
    file: viewUrl,
    lang: document.documentElement.lang,
    scheme: document.documentElement.dataset.nativeColorScheme ?? 'dark',
  });
  frame.src = `/pdf/index.html?${params}`;
  signal?.addEventListener(
    'abort',
    () => {
      frame.remove();
    },
    { once: true },
  );
  return frame;
}
