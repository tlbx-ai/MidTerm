# Responsive layout and desktop acceptance

The compact layout uses a single boundary: **768 CSS pixels**. Above that width,
the desktop layout applies. A CSS pixel already incorporates device pixel ratio;
do not multiply the breakpoint by DPR or infer layout from touch, hover, or user
agent. Physical input capabilities still select input handling (for example
touch gestures and camera acquisition), not the presentation of the Command Bay.

The shell consumes `--safe-area-inset-top/right/bottom/left`, whose defaults are
the corresponding CSS `env(safe-area-inset-*)` values. Floating automation and
special-key menus use the same bounds. The browser must report real display
insets: width and density alone cannot identify notches or rounded corners.
The variables can be overridden to reproduce those bounds in desktop Chrome.

## Local iteration

Run `scripts/dev.ps1` on a free source port, keeping the installed service on
2000. In the supervising session, load its generated `.tlbx/tlbx_cli.ps1`:

```powershell
mt_preview responsive
mt_open https://127.0.0.1:2100/
mt_viewport -Width 390 -Height 844
mt_exec 'JSON.stringify({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,coarse:matchMedia("(pointer:coarse)").matches})'
```

Use a disposable Terminal in the source instance with Command Bay enabled.
The existing `mt_viewport` API controls actual iframe width and height; it does
not change the browser's pointer capabilities or DPR. Chrome's device metrics
override can vary DPR with `mobile:false`, preserving desktop rendering and mouse
input. Read `devicePixelRatio` in the target to verify the override actually stuck.

```powershell
./scripts/verify-responsive.ps1 -HelperPath Q:\repos\Jpa\.tlbx\tlbx_cli.ps1
./scripts/verify-responsive.ps1 -HelperPath Q:\repos\Jpa\.tlbx\tlbx_cli.ps1 `
  -Widths 320,390,430 -Height 420 -OutputPath .dev/short-responsive.json
```

The check applies 24/16/34/16-pixel test insets, opens tools and auxiliary keys,
and verifies measured viewport sizes, the layout boundary, horizontal overflow,
safe bounds, 44-pixel tool targets, intact key groups, and prompt/send alignment.
It restores inset overrides and tool state and resets the preview viewport.
Run it with an attachment too, then visually inspect the tools, long filenames,
automation menu, symbol popup, expanded composer, and ordinary desktop layout.
Short viewports exercise constrained space; they do not emulate native keyboard
composition, camera permissions, clipboard permissions, or browser suspension.

## Changes and acceptance, 2026-09-05

- Removed the touch-dependent 1024px presentation branch and coarse-pointer
  background, scrollbar, history-thumb, and auxiliary-key presentation decisions.
- Removed the installed non-iOS PWA rule that zeroed the upper safe inset.
  The compact shell now owns its inset padding; its terminal/footer do not repeat it.
- Kept tools in the compact tools panel so automatic pins cannot squeeze the prompt.
  Send/tools align with the input when attachments are present. Tool icons have a
  shared width, labels can wrap, and modifier/arrow/category groups stay together.
- Clamped floating menus to safe viewport bounds, made oversized key menus
  scrollable, and preserved 44px targets in the compact tool surfaces.
- Desktop Chrome in the tlbx preview passed widths 320, 390, 430, 768, 769,
  1024, and 1440 at DPR 1 and 3 with mouse input, and DPR 2 with coarse/no-hover
  input. All three profiles selected the same layout boundary. Short 420px-high
  views with actual uploaded attachments also passed.
- Ten tool-panel toggles at 390x844 caused **zero terminal geometry shift**;
  the Chrome profile passed with frame p95 16.7ms and retained heap growth 0.31MiB.
  Actual Command Bay submission produced `RESPONSIVE_OK` in the disposable PTY.

Local evidence lives in `.dev/responsive/final-*.json`; the performance summary is
`C:\Users\johan\.codex\artifacts\chrome-perf\20260905-041918-responsive-command-bay\summary.json`.
Screenshots were inspected through the supervising JPA preview. Native device
inset reporting and OS input behavior remain hardware integration concerns;
responsive layout acceptance no longer requires a mobile user agent.

During this run, resetting a self-preview rotated the host-scoped client cookie
and invalidated its former preview-owner ID. Reclaiming the current browser ID
restored control. This is a separate preview identity follow-up; ordinary width
changes worked without a reset.

## Keyboard replacement follow-up

The special-key keyboard now occupies its own surface below the composer.
Opening it captures the current visual viewport boundary before blurring the
native input. As the OS keyboard closes, that boundary stays fixed and the
custom surface takes the released space. ABC retains the boundary until the
returning native keyboard reaches it; the dismiss control releases it entirely.
Opening without an OS keyboard reserves up to 320px (45% in short viewports).
Width changes discard the old orientation's reservation. The open state is
transient, never restored from local storage.

Category keys render inside this surface and remain open after input. Opening
a category replaces the modifier/arrow rows with the selected keys. The key
area scrolls when needed; no symbol popup covers the terminal. The old extra
10-24px OSK bottom guard is removed. With no keyboard, the shell protects the
bottom controls with max(24px, reported safe inset). The replacement keyboard
owns that inset while open; it is not repeated above the OS keyboard.

Validation: 13 focused viewport/transition tests pass. Direct source Chrome at
390x844, DPR 2, simulated visual viewport heights 500/550/650/844 measured zero
terminal top/bottom/height drift on replacement and on the ABC return. A real
symbol click reached the disposable PTY and left the category open. Insets
24/16/34/16 placed the composer at x22..368 and y760..804, inside the 390x844
viewport. Evidence is in `.dev/keyboard/{geometry,return,safe}.json` and the
corresponding PNGs. This is browser geometry evidence; Android/iOS native
keyboard animation and physical rounded corners still require device testing.
The tlbx preview bridge reported owner-offline, so this check used direct CDP.
