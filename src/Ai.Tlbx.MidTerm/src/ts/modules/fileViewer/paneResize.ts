interface PaneBounds {
  min: number;
  max: number;
  enabled: boolean;
}
interface PaneResizeOptions {
  panel: HTMLElement;
  grip: HTMLElement;
  key: string;
  defaultWidth: number;
  responsiveDefault?: () => number;
  direction: 1 | -1;
  widthProperty?: string;
  bounds: () => PaneBounds;
  observe: HTMLElement[];
  changed?: () => void;
}

/** Owns only presentation width; session/PTY sizing stays in the existing layout pipeline. */
export function resizeFilePane(options: PaneResizeOptions): {
  refresh: () => void;
  dispose: () => void;
} {
  const { panel, grip } = options;
  const events = new AbortController();
  let preferred = options.defaultWidth;
  let hasPreference = false;
  try {
    const saved = Number(localStorage.getItem(options.key));
    if (Number.isFinite(saved) && saved >= 100 && saved <= 2000) {
      preferred = saved;
      hasPreference = true;
    }
  } catch {
    /* Resizing remains available when storage is blocked. */
  }
  let drag: { id: number; x: number; width: number; original: number } | null = null;
  let frame = 0;
  let actualWidth = -1;

  const refresh = (): void => {
    const bounds = options.bounds();
    if (!hasPreference && !drag && options.responsiveDefault)
      preferred = options.responsiveDefault();
    grip.hidden = !bounds.enabled;
    const width = Math.round(Math.max(bounds.min, Math.min(bounds.max, preferred)));
    panel.style.setProperty(options.widthProperty ?? '--file-pane-width', `${width}px`);
    grip.setAttribute('aria-valuemin', String(Math.round(bounds.min)));
    grip.setAttribute('aria-valuemax', String(Math.round(bounds.max)));
    grip.setAttribute('aria-valuenow', String(width));
    grip.setAttribute('aria-valuetext', `${width} px`);
    const measured = panel.getBoundingClientRect().width;
    if (measured !== actualWidth) {
      actualWidth = measured;
      options.changed?.();
    }
  };
  const schedule = (): void => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      refresh();
    });
  };
  const save = (): void => {
    hasPreference = true;
    const bounds = options.bounds();
    preferred = Math.round(Math.max(bounds.min, Math.min(bounds.max, preferred)));
    try {
      localStorage.setItem(options.key, String(preferred));
    } catch {
      /* Current layout still works. */
    }
  };
  const finish = (cancelled: boolean): void => {
    if (!drag) return;
    const previous = drag;
    drag = null;
    if (cancelled) preferred = previous.original;
    else save();
    grip.classList.remove('active');
    if (grip.hasPointerCapture(previous.id)) grip.releasePointerCapture(previous.id);
    refresh();
  };
  grip.tabIndex = 0;
  grip.setAttribute('role', 'separator');
  grip.setAttribute('aria-orientation', 'vertical');
  grip.addEventListener(
    'pointerdown',
    (event) => {
      if (event.button !== 0 || !event.isPrimary || !options.bounds().enabled) return;
      drag = {
        id: event.pointerId,
        x: event.clientX,
        width: panel.getBoundingClientRect().width,
        original: preferred,
      };
      grip.setPointerCapture(event.pointerId);
      grip.classList.add('active');
      grip.focus({ preventScroll: true });
      event.preventDefault();
      event.stopPropagation();
    },
    { signal: events.signal },
  );
  grip.addEventListener(
    'pointermove',
    (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      preferred = drag.width + options.direction * (event.clientX - drag.x);
      schedule();
      event.preventDefault();
      event.stopPropagation();
    },
    { signal: events.signal },
  );
  grip.addEventListener(
    'pointerup',
    () => {
      finish(false);
    },
    { signal: events.signal },
  );
  grip.addEventListener(
    'pointercancel',
    () => {
      finish(true);
    },
    { signal: events.signal },
  );
  grip.addEventListener(
    'lostpointercapture',
    () => {
      finish(true);
    },
    { signal: events.signal },
  );
  grip.addEventListener(
    'keydown',
    (event) => {
      if (!options.bounds().enabled) return;
      if (event.key === 'Escape' && drag) finish(true);
      else if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        const bounds = options.bounds();
        if (event.key === 'Home') preferred = bounds.min;
        else if (event.key === 'End') preferred = bounds.max;
        else
          preferred =
            panel.getBoundingClientRect().width +
            options.direction * (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 50 : 10);
        save();
        refresh();
      } else return;
      event.preventDefault();
      event.stopPropagation();
    },
    { signal: events.signal },
  );
  grip.addEventListener(
    'dblclick',
    () => {
      preferred = options.defaultWidth;
      save();
      refresh();
    },
    { signal: events.signal },
  );
  const observer = new ResizeObserver(schedule);
  for (const target of options.observe) observer.observe(target);
  refresh();
  return {
    refresh,
    dispose() {
      finish(true);
      events.abort();
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    },
  };
}
