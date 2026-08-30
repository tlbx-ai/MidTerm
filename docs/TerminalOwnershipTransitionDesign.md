# Terminal Ownership Transition Design

## Status

Review plan only. The ownership and ordering prerequisites are implemented separately; the visual transition work in this document is not yet implemented.

## Purpose

Terminal geometry is owned per terminal session, while several browser windows, tabs, devices, and surfaces may observe that session. Ownership can change without making the terminal look unstable. This plan defines the next UI pass: one canonical visual state per frame, no transient contradictory badges, and no visible sequence of resize, scale, overlay, and focus corrections.

## Visual Thesis

The terminal canvas is the stable object. Browser chrome explains who controls its geometry, but ownership bookkeeping must never visually dismantle and rebuild the canvas. A handoff should read as one quiet state change, not as a chain of implementation steps.

The visual hierarchy is:

1. terminal content remains primary and keeps its last coherent geometry;
2. a compact ownership notice appears only for a follower or a pending explicit handoff;
3. device identity and the takeover action are secondary context;
4. connection, epoch, resize, and retry internals never appear as user-facing progress narration.

## Content Plan

### Owner

- no ownership overlay;
- terminal renders at the last server-confirmed owner geometry;
- ordinary focus and input behavior remains unchanged.

### Follower

- one viewport-docked notice names the controlling device when known;
- one explicit `Continue here` action;
- the terminal keeps the last coherent server geometry and may be passively scaled;
- empty terminal grid space must not move or resize the notice.

### Explicit handoff pending

- the existing notice stays in place and changes only its action state;
- one short present-tense label such as `Switching here…`;
- no second spinner, toast, status badge, or optimistic owner presentation.

### Handoff rejected or superseded

- remain in the canonical follower state returned by the server;
- restore the action in the same reserved footprint;
- show an error only for a durable failure that needs user action, not for an expected stale-epoch loss.

### Owner disconnected

- keep the current follower presentation during the grace period;
- do not expose countdowns or connectivity internals;
- after canonical takeover eligibility and a successful claim, commit directly to owner presentation.

## Interaction Thesis

Every ownership transition is a transaction keyed by `(sessionId, epoch)`. The browser may prepare measurements off-screen, but it presents only the last committed snapshot or the next fully coherent snapshot. It must never publish an intermediate mixture such as new ownership with old geometry, old ownership with a new badge, or two competing takeover actions.

Explicit handoff uses compare-and-swap semantics against the epoch the user saw. A stale request loses quietly and adopts the newer canonical state. Automatic takeover is limited to the active or focused terminal and never starts from a merely visible background pane.

## Presentation State Model

Each terminal has one immutable browser-side presentation snapshot:

```text
TerminalPresentationSnapshot
  sessionId
  epoch
  role: owner | follower
  ownerOnline
  ownerLabel
  canonicalCols
  canonicalRows
  viewportWidth
  viewportHeight
  passiveScale
  actionState: idle | claiming
```

State transitions are reduced in memory first. DOM classes, overlay content, xterm geometry, passive scale, and focus eligibility are then committed together in one animation-frame transaction.

## Atomic Commit Rules

1. A lower epoch never replaces a higher committed epoch.
2. A same-epoch update may refine connectivity or labels, but cannot reverse owner identity.
3. Ownership is not shown optimistically. A browser becomes visually authoritative only after the server confirms the new epoch.
4. Required measurements happen before the visible commit.
5. Overlay dimensions are reserved, so `idle` to `claiming` does not shift the terminal.
6. Terminal scaling and gap fillers derive from the same snapshot and update in the same frame.
7. Focus moves only after the owner snapshot has committed.
8. Hidden panes store state but perform no presentation transition until shown; on reveal they render the newest snapshot directly.
9. Reduced-motion mode uses the identical state machine with no animation.
10. Reconnect replaces the local snapshot from one server snapshot; replayed older command responses cannot repaint it.

## Motion Contract

Motion is optional polish, never state transport.

- owner/follower notice: opacity transition only, 100–140 ms;
- no terminal translate, zoom, spring, or geometry animation;
- no animated resize between row/column counts;
- no stagger between badge, scale, gap fillers, and action state;
- a transition interrupted by a newer epoch commits the newer snapshot immediately;
- background and hidden documents do not queue animations for later playback.

## Implementation Sequence

### Phase 1 — Presentation reducer

- introduce the immutable snapshot and a pure reducer;
- consolidate current overlay, scaling, gap-fill, and focus decisions behind it;
- retain the existing server ownership contract and xterm lifecycle;
- add table-driven tests for owner, follower, pending, stale response, reconnect, and hidden reveal.

### Phase 2 — Atomic renderer

- stage all DOM mutations and commit them in one `requestAnimationFrame` callback;
- reserve overlay/action geometry;
- cancel superseded frame work per terminal;
- add mutation-observer tests that reject contradictory intermediate class combinations.

### Phase 3 — Visual polish

- add the restrained opacity transition;
- normalize mobile and desktop notice placement without changing terminal dimensions;
- ensure badges are docked to the tlbx viewport rather than xterm rows/columns;
- validate reduced motion, browser zoom, OS scaling, and soft-keyboard appearance.

### Phase 4 — Instrumented browser acceptance

- run two independent browser profiles plus duplicated-tab cases;
- capture frame screenshots around handoff and reconnect;
- collect Chrome performance traces and layout-shift entries;
- fail the smoke test on blank terminal frames, multiple ownership notices, stale-epoch repaint, or unexpected focus transfer.

## Acceptance Matrix

The implementation is ready only when these transitions are deterministic:

| Start | Event | Required visible result |
| --- | --- | --- |
| desktop owner, mobile follower | mobile explicitly continues | one direct commit to mobile owner; desktop becomes follower once |
| mobile owner, desktop follower | mobile disconnects | no immediate takeover; desktop stays coherent through grace |
| offline owner after grace | active follower interacts | direct owner commit; no intermediate unowned frame |
| two followers at same epoch | both click continue | one winner; loser adopts winner state without owner flash |
| duplicated tab ID | collision discovered late | duplicate rekeys/reloads; original tab and terminal identity remain stable |
| hidden follower | ownership changes twice | reveal latest epoch only; no replay of intermediate transitions |
| active Terminal to Files/Agent tab | surface changes | browser activity reports the actual surface; no terminal auto-claim |
| repeated ACP activation triggers | same session opens | one attach and one live stream; no activation-state flicker |
| server reconnect | delayed old response arrives | current snapshot remains; no badge or scale regression |
| mobile keyboard opens/closes | viewport changes | notice remains viewport-docked; terminal never shows a blank frame |

## Performance And Robustness Gates

- zero uncaught errors and zero duplicate WebSocket/runtime attach actions;
- zero contradictory ownership DOM states observed between animation frames;
- cumulative layout shift from ownership chrome below `0.01` per handoff;
- no long task above 50 ms attributable to a handoff on the reference desktop profile;
- no retained animation callbacks, observers, or per-session render work after session teardown;
- terminal buffer content remains visible throughout every handoff and reconnect capture.

## Non-Goals

- no migration layer for obsolete in-memory frontend state;
- no redesign of terminal ownership policy;
- no combined Terminal/ACP runtime abstraction;
- no decorative transition system or global animation framework;
- no user-facing narration of epochs, leases, retries, or internal workflow history.

## Review Decisions Requested

Before implementation, review only these choices:

1. approve the terminal-canvas-first visual thesis;
2. approve opacity-only motion and the no-geometry-animation rule;
3. approve the immutable snapshot plus single-frame commit boundary;
4. approve the acceptance matrix and quantitative browser gates.
