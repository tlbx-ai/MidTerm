# Lens Design

## Purpose

This document is the source of truth for the visual and interaction design of MidTerm Lens. It exists to prevent Lens UI behavior from drifting across ad hoc iterations.

Lens is a provider-backed conversation surface for explicit Codex and Claude sessions. It is not a terminal transcript viewer, and its visual system must be designed as a lean, high-signal web UI for agent interaction.

Any future Lens UI change that affects layout, hierarchy, history ordering, timeline rendering, typography, spacing, scrolling, item rendering, or interaction states must update this document with the new fundamental rule or revised rationale.

## Progress Tracking

This document is intentionally split into:

- specified: the rules MidTerm Lens must satisfy
- implemented: the rules that are currently implemented and verified in code

When Lens UX changes, update both sections in the same work. If a rule is specified but not yet implemented, leave that gap visible instead of silently drifting the document.

## Scope

This document governs:

- history ordering and grouping
- rendering of user messages, assistant output, tool activity, diffs, approvals, and plan-mode questions
- composer and ready-state presentation
- spacing, typography, hierarchy, density, and use of screen space
- DOM/performance constraints for long-running sessions

Provider-specific transport details belong in the C# runtime layer, not here. This document describes the Lens UX contract after provider events have been normalized into MidTerm-owned concepts.

## Terminology

- `history` means the canonical provider-backed ordered sequence of Lens items.
- `timeline` means the rendered visual presentation of that history in the Lens UI.
- `transcript` is reserved for PTY/terminal capture or unavoidable legacy wire/schema names and should not be used as the Lens UI concept.

## Core Principles

### 1. Stable chronology

- The history/timeline must be strictly chronological and visually stable.
- New items must append in a predictable order.
- Existing items may update in place while streaming, but must not jump above or between older completed items unless the underlying turn/item identity itself is wrong.
- Reordering bugs are correctness bugs, not cosmetic issues.

### 2. Minimal clutter

- Prefer a clean history timeline over chat-card chrome.
- Do not wrap every event in heavy bordered cards.
- Avoid redundant labels, duplicate timestamps, duplicate avatars, and repeated status chips.
- Use separators, spacing, and type hierarchy instead of ornamental containers.

### 3. One interaction model

- User messages, assistant output, tool progress, approvals, diffs, and plan-mode questions should feel like one coherent history/timeline system.
- Different item kinds may have different treatments, but they must share one visual grammar.
- The UI should not feel like unrelated widgets stacked in one column.

### 4. Efficient use of space

- Lens should use the available width and height intentionally.
- Avoid narrow bubble layouts that waste the center column.
- Long assistant output should read like a document, not like a chat toy.
- Tool activity should compress well and expand only when detail is useful.
- Codex Lens should use a full-width, left-anchored timeline instead of a centered conversation lane.
- In Codex Lens, user and assistant rows should share the same left edge and be distinguished primarily by subdued small labels rather than opposing alignment or strong bubble chrome.

### 5. Clear hierarchy

- The user must be able to scan the history timeline and immediately distinguish:
  - user intent
  - assistant response
  - active work in progress
  - completed tool actions
  - questions requiring user action
  - file/diff related changes
- Hierarchy should come from typography, spacing, tone, and motion restraint, not decoration.

### 6. Lean DOM

- Lens must not retain thousands of history nodes in the live DOM.
- Once the visible history grows beyond roughly 50 rendered items, older items should be virtualized out of the active DOM window.
- Virtualization must preserve stable scroll behavior and not break streaming updates at the bottom.
- Lens history transport should be window-aware: MidTerm may deliver only the currently materialized history slice plus total-count/window metadata, and the UI should request older or newer slices on demand instead of assuming the full history is resident in the browser.
- Browser-resident Lens history should stay bounded to a working window instead of accumulating the full session scrollback in memory.
- When a Lens surface becomes hidden or inactive, its rendered history DOM should be dropped and its retained browser-side history window should collapse back toward a small latest-history slice while the runtime keeps ingesting canonical state.

### 7. Responsive behavior

- Lens must remain fully usable on mobile-sized viewports.
- Mobile Lens should preserve history hierarchy, composer usability, and request/approval handling without forcing pinch-zoom or horizontal history reading.
- Responsive behavior must be designed, not treated as desktop shrinkage.

### 8. Internationalized MidTerm UI copy

- Every MidTerm-provided Lens label, action, helper text, ready-state string, empty-state string, and interruption string must come from i18n keys.
- Provider content is not translated by MidTerm, but MidTerm-owned UI strings must not be hardcoded English in the renderer.

### 9. Streaming-first feedback

- Lens must show incremental assistant stream chunks as they arrive.
- The UI must not depend on a final assistant message before showing useful user feedback.
- Streaming state should feel low-latency and in-place instead of replacing one row with a later unrelated row.

### 10. Scroll-follow discipline

- Lens should auto-follow the live edge by default.
- If the user scrolls away from the bottom, automatic scrolling must stop immediately.
- Automatic scrolling may resume only after the user reaches the bottom again or explicitly presses a "back to bottom" control.
- When the user seeks into older history, Lens should expand or shift the history window deterministically without resetting the live Lens session or replaying the entire history from scratch.

### 11. Terminal-font monospace usage

- Diffs, code blocks, command output, script output, tool text, file-change output, and similar machine-oriented content should use the configured terminal font stack.
- Lens must not invent a separate monospace language that diverges from the terminal's configured typography.

## Visual System

### Typography

- Use at most 2 to 4 font styles across the Lens surface.
- Reserve stronger styles for true hierarchy boundaries only.
- Favor readable body text and restrained metadata styling.
- Monospace should be used for code, commands, paths, and diffs only.

### Containers

- Default history rows should not use card-heavy presentation.
- Use lightweight blocks with strong spacing and alignment.
- Borders, fills, and backgrounds should be sparse and purposeful.
- Only exceptional states such as approvals, errors, or diff summaries may justify stronger containment.

### Color and emphasis

- Color should communicate meaning sparingly.
- Persistent accent color usage should be limited to active/ready/progress states and important calls to action.
- Avoid rainbow status noise across history rows.

### Motion

- Streaming and item updates should feel alive but subtle.
- Use restrained transitions for stream growth, tool state changes, and ready-state changes.
- Avoid layout thrash and avoid motion that causes the eye to lose reading position.

## History Model

### Ordering

- Turns and items must render in canonical order from the backend identity model.
- A streaming assistant response should update its existing row in place.
- Tool updates should attach to the owning turn and item instead of spawning visually disjoint duplicates.

### User messages

- User prompts should be visually distinct but compact.
- They should anchor the start of a turn without dominating the screen.
- Repeated rendering of the same user turn is forbidden.

### Assistant output

- Assistant content is the primary reading surface and should have the clearest typography.
- Streaming text should appear incrementally in place.
- The assistant row should not visually reset between deltas.
- The timeline should use one trailing busy bubble as the sole animated activity indicator while the provider is actively working.
- Per-row fake activity indicators should not linger inside older history rows.
- When the final assistant item lands, the row should settle into its completed state without a hard replace, jump, or scroll jolt.

### Tool activity

- Tool activity should be visible, but compressed by default.
- Starts, progress, completion, and failure should read as one evolving activity line or block where possible.
- Raw transport noise must not leak into the UI.
- Long machine-oriented bodies such as command output, file-change output, reasoning blocks, and similar tool-style details should collapse into unfoldable disclosure panels by default once they are stable.
- Collapsed tool-style panels should expose a short preview plus line-count context so the user can scan relevance before expanding.
- Tool commands, command output, file paths, and other machine-oriented detail should use the configured terminal monospace stack.
- Command/file-read noise should be summarized for screen use instead of dumping full raw terminal-like output into Lens history.
- File-read commands should surface the path and a compact excerpt policy, not the full file body.
- Generic command output should prefer compact head/tail or tail-oriented summaries with omitted-line markers over unbounded dumps.

### Plan-mode questions and approvals

- Requests that require user action must stand out clearly from passive history content.
- They should read like the next required interaction, not like another log entry.
- The composer and action affordances should align with that state.

### Diffs and file changes

- Diffs should be surfaced as first-class work artifacts, not buried in generic tool logs.
- Summaries should stay compact, with expansion for detail.
- File-oriented information should use monospace sparingly and preserve readability.

## Composer And Ready State

- The composer is the primary action control for Lens sessions.
- Lens should expose a compact quick-settings strip in or immediately above the smart input bar for the settings users change in-flow most often.
- The quick-settings strip should stay intentionally small and session-oriented.
- The common quick-settings surface should cover:
  - model
  - effort
  - plan mode
  - permission or approval mode
- These quick controls should be MidTerm-owned canonical settings, not scraped provider-native menus.
- Provider-specific meaning and transport mapping for those controls must stay in the C# Lens runtime layer.
- The TypeScript Lens UI should render the common quick-settings surface from the canonical model without branching deeply on provider quirks.
- Quick-settings changes should be sticky for the active Lens session and may also reuse provider-level draft defaults where that improves flow.
- Quick-settings must communicate whether they affect the next turn, the active session runtime, or require a thread/runtime reopen behind the scenes.
- A subtle ready indication must show when the provider runtime is connected and can accept input.
- Ready-state presentation should be understated, always visible, and never confused with history content.
- Sending, streaming, awaiting approval, and awaiting user input should each have clear but low-noise state treatment.

## Performance Rules

- Streaming must not cause full history/timeline rerenders.
- Live Lens transport should flow as `provider event -> mt canonical stream state -> /ws/lens delta -> visible row patch`.
- Item updates should target stable DOM anchors keyed by canonical identity.
- Virtual scrolling must remove old items from the live DOM when the history becomes large.
- Rich items such as diffs or tool logs should support collapsed rendering by default.

## Dev Diagnostics

- In dev mode, MidTerm should write one GUID-named Lens screen log per session under the normal MidTerm log root.
- The Lens screen log should be derived from canonical Lens history deltas, not raw provider transport payloads or frontend DOM scraping.
- Screen-log records should include the rendered-history facts needed to discuss the UI: stable history identity, kind, label, title, meta, body, render mode, and whether the body collapses by default.

## Design Review Checklist

Any significant Lens UI change should be checked against these questions:

1. Does history order remain stable while streaming and while tool items update?
2. Did this change reduce clutter or add it?
3. Is the hierarchy clearer than before?
4. Did we keep the number of visual patterns low?
5. Does the design use width and height better than the previous state?
6. Does it avoid heavy card stacks?
7. Does it preserve a lean DOM and a virtualization path for long sessions?
8. Did the change keep provider-specific event quirks out of the TypeScript UI layer?

## Change Discipline

- When Lens visual behavior changes, update this document in the same work.
- Do not treat this file as aspirational prose. It is part of the feature contract.
- If implementation temporarily violates a rule here, document the gap and the intended correction.

## Implemented

Status in this branch/work item:

- implemented: stable history virtualization with a bounded render window instead of keeping the full long history in the DOM
- implemented: deterministic history render planning plus keyed visible-row reconciliation instead of rebuilding the whole visible history subtree on every update
- implemented: scroll-follow suppression while the user is away from the live edge, plus an explicit return-to-bottom control
- implemented: terminal-font monospace rendering for machine-oriented Lens content
- implemented: provider-stream-driven assistant rendering so partial assistant text can appear before the final provider message lands
- implemented: responsive Lens styling for mobile-sized layouts
- implemented: Lens-specific themed CSS tokens layered onto the existing MidTerm theme system
- implemented: i18n-backed MidTerm Lens labels, buttons, helper copy, ready-state text, and interruption text
- implemented: hidden/background Lens sessions may continue ingesting runtime state, but history DOM work is deferred until that Lens surface is visible again
- implemented: hidden/background Lens sessions clear rendered history DOM and compact retained browser-side history back to a bounded latest window without interrupting the live runtime
- implemented: long machine-oriented Lens bodies collapse into unfoldable disclosure panels by default, with line-count and preview context for quick scanning
- implemented: tool-style titles and bodies use the configured terminal monospace stack consistently
- implemented: dev mode writes one GUID-named per-session Lens screen log derived from canonical history deltas and render hints
- implemented: Lens uses one artificial trailing busy bubble while a turn is active instead of leaving per-row activity indicators running inside history entries
- implemented: command and file-read tool output is screen-summarized before it reaches both the Lens UI and the dev screen log
- implemented: Codex Lens uses a full-width left-anchored history/composer layout instead of the previous centered lane
- implemented: Codex Lens distinguishes user and assistant rows with quiet `User` and `Agent` labels rather than right-floating user bubbles
- implemented: Lens exposes a compact quick-settings strip in the smart input bar for model, effort, plan mode, and permission mode
- implemented: quick-settings state is MidTerm-owned and canonical, while Codex and Claude permission/runtime mappings stay in the C# host/runtime layer
- implemented: Lens quick-settings drafts stay sticky per session and reuse provider-level remembered defaults for recurring workflows

Still mandatory after this work whenever Lens evolves:

- keep this section current
- add new fundamentals here when they become real feature behavior
- document temporary violations instead of letting the implementation and spec drift apart
