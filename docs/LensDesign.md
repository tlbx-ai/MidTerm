# Lens Design

## Purpose

This document is the source of truth for the visual and interaction design of MidTerm Lens. It exists to prevent Lens UI behavior from drifting across ad hoc iterations.

Lens is a provider-backed conversation surface for explicit Codex and Claude sessions. It is not a terminal transcript viewer, and its visual system must be designed as a lean, high-signal web UI for agent interaction.

Any future Lens UI change that affects layout, hierarchy, transcript ordering, typography, spacing, scrolling, item rendering, or interaction states must update this document with the new fundamental rule or revised rationale.

## Progress Tracking

This document is intentionally split into:

- specified: the rules MidTerm Lens must satisfy
- implemented: the rules that are currently implemented and verified in code

When Lens UX changes, update both sections in the same work. If a rule is specified but not yet implemented, leave that gap visible instead of silently drifting the document.

## Scope

This document governs:

- transcript ordering and grouping
- rendering of user messages, assistant output, tool activity, diffs, approvals, and plan-mode questions
- composer and ready-state presentation
- spacing, typography, hierarchy, density, and use of screen space
- DOM/performance constraints for long-running sessions

Provider-specific transport details belong in the C# runtime layer, not here. This document describes the Lens UX contract after provider events have been normalized into MidTerm-owned concepts.

## Core Principles

### 1. Stable chronology

- The transcript must be strictly chronological and visually stable.
- New items must append in a predictable order.
- Existing items may update in place while streaming, but must not jump above or between older completed items unless the underlying turn/item identity itself is wrong.
- Reordering bugs are correctness bugs, not cosmetic issues.

### 2. Minimal clutter

- Prefer a clean transcript over chat-card chrome.
- Do not wrap every event in heavy bordered cards.
- Avoid redundant labels, duplicate timestamps, duplicate avatars, and repeated status chips.
- Use separators, spacing, and type hierarchy instead of ornamental containers.

### 3. One interaction model

- User messages, assistant output, tool progress, approvals, diffs, and plan-mode questions should feel like one coherent transcript system.
- Different item kinds may have different treatments, but they must share one visual grammar.
- The UI should not feel like unrelated widgets stacked in one column.

### 4. Efficient use of space

- Lens should use the available width and height intentionally.
- Avoid narrow bubble layouts that waste the center column.
- Long assistant output should read like a document, not like a chat toy.
- Tool activity should compress well and expand only when detail is useful.

### 5. Clear hierarchy

- The user must be able to scan the transcript and immediately distinguish:
  - user intent
  - assistant response
  - active work in progress
  - completed tool actions
  - questions requiring user action
  - file/diff related changes
- Hierarchy should come from typography, spacing, tone, and motion restraint, not decoration.

### 6. Lean DOM

- Lens must not retain thousands of transcript nodes in the live DOM.
- Once the visible transcript grows beyond roughly 50 rendered items, older items should be virtualized out of the active DOM window.
- Virtualization must preserve stable scroll behavior and not break streaming updates at the bottom.

### 7. Responsive behavior

- Lens must remain fully usable on mobile-sized viewports.
- Mobile Lens should preserve transcript hierarchy, composer usability, and request/approval handling without forcing pinch-zoom or horizontal transcript reading.
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

- Default transcript entries should not use card-heavy presentation.
- Use lightweight blocks with strong spacing and alignment.
- Borders, fills, and backgrounds should be sparse and purposeful.
- Only exceptional states such as approvals, errors, or diff summaries may justify stronger containment.

### Color and emphasis

- Color should communicate meaning sparingly.
- Persistent accent color usage should be limited to active/ready/progress states and important calls to action.
- Avoid rainbow status noise across transcript rows.

### Motion

- Streaming and item updates should feel alive but subtle.
- Use restrained transitions for stream growth, tool state changes, and ready-state changes.
- Avoid layout thrash and avoid motion that causes the eye to lose reading position.

## Transcript Model

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

### Tool activity

- Tool activity should be visible, but compressed by default.
- Starts, progress, completion, and failure should read as one evolving activity line or block where possible.
- Raw transport noise must not leak into the UI.

### Plan-mode questions and approvals

- Requests that require user action must stand out clearly from passive transcript content.
- They should read like the next required interaction, not like another log entry.
- The composer and action affordances should align with that state.

### Diffs and file changes

- Diffs should be surfaced as first-class work artifacts, not buried in generic tool logs.
- Summaries should stay compact, with expansion for detail.
- File-oriented information should use monospace sparingly and preserve readability.

## Composer And Ready State

- The composer is the primary action control for Lens sessions.
- A subtle ready indication must show when the provider runtime is connected and can accept input.
- Ready-state presentation should be understated, always visible, and never confused with transcript content.
- Sending, streaming, awaiting approval, and awaiting user input should each have clear but low-noise state treatment.

## Performance Rules

- Streaming must not cause full transcript rerenders.
- Item updates should target stable DOM anchors keyed by canonical identity.
- Virtual scrolling must remove old items from the live DOM when the transcript becomes large.
- Rich items such as diffs or tool logs should support collapsed rendering by default.

## Design Review Checklist

Any significant Lens UI change should be checked against these questions:

1. Does transcript order remain stable while streaming and while tool items update?
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

- implemented: stable transcript virtualization with a bounded render window instead of keeping the full long history in the DOM
- implemented: scroll-follow suppression while the user is away from the live edge, plus an explicit return-to-bottom control
- implemented: terminal-font monospace rendering for machine-oriented Lens content
- implemented: provider-stream-driven assistant rendering so partial assistant text can appear before the final provider message lands
- implemented: responsive Lens styling for mobile-sized layouts
- implemented: Lens-specific themed CSS tokens layered onto the existing MidTerm theme system
- implemented: i18n-backed MidTerm Lens labels, buttons, helper copy, ready-state text, and interruption text

Still mandatory after this work whenever Lens evolves:

- keep this section current
- add new fundamentals here when they become real feature behavior
- document temporary violations instead of letting the implementation and spec drift apart
