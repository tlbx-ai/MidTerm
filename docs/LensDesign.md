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

- the canonical Lens history architecture and ownership boundary
- history ordering and grouping
- rendering of user messages, assistant output, tool activity, diffs, approvals, and plan-mode questions
- composer and ready-state presentation
- spacing, typography, hierarchy, density, and use of screen space
- DOM/performance constraints for long-running sessions

Provider-specific transport details belong in the C# runtime layer, not here. This document describes the Lens UX contract after provider events have been normalized into MidTerm-owned concepts.

## Non-Regression Floor

Lens is already a usable operator surface. Architectural cleanup may replace any part of the plumbing underneath it, but the visible result after those changes must not regress below the current Lens floor.

That floor currently includes:

- stable chronological history rows
- readable assistant output with low-latency streaming
- persistent `Ran …` command rows with folded output tails
- usable diff rendering and file/work artifact visibility
- deterministic live-edge follow by default
- deterministic older-history paging through a bounded virtualized window
- compact browser-side history retention instead of unbounded browser memory growth

Future refactors may improve or replace the implementation of any of the above, but they must not ship a Lens UI that is less usable than the current surface.

## Terminology

- `history` means the canonical provider-backed ordered sequence of Lens items.
- `history item` means one canonical, self-renderable Lens entry in that sequence. Each item has a type that determines how the frontend renders it.
- `history window` means a contiguous absolute index range within canonical history.
- `history count` means the current total number of canonical history items.
- `timeline` means the rendered visual presentation of that history in the Lens UI.
- `transcript` is reserved for PTY/terminal capture or unavoidable legacy wire/schema names and should not be used as the Lens UI concept.

## Naming Contract

New Lens work must use the following concept names consistently:

- use `history` for the canonical ordered Lens item sequence
- use `history item` for one canonical renderable entry
- use `history window` for an absolute index range inside canonical history
- use `history count` for the total number of canonical history items
- use `timeline` for the rendered visual presentation of history in the UI
- use `provider event` for raw Codex or Claude structured inputs before canonization
- use `canonization` for the provider-to-canonical mapping step in `mtagenthost`
- use `canonical item type` for the backend-defined item kind that determines frontend rendering behavior
- use `interview item` for the dedicated question-list widget style item type

The following legacy names should be treated as deprecated for Lens architecture and Lens UI discussion:

- `transcript`
- `transcript entry`
- transport-era snapshot/delta naming that predates the canonical history model

Allowed legacy usage:

- existing wire types, DTOs, schema fields, and service names may continue to use legacy names until they are migrated
- when referring to those legacy symbols, pair them with the intended concept name in docs, reviews, and code comments where useful

Preferred migration language:

- say `history item` instead of `transcript entry`
- say `history window fetch` instead of `snapshot window` when discussing the intended architecture
- say `provider event stream` instead of older live-feed transport wording
- say `canonical history service` instead of older reducer/live-feed service wording

Naming rule:

- no new Lens-facing type, service, DTO, field, API shape, document section, or frontend concept should introduce fresh `transcript` or transport-era live-feed naming unless it is intentionally preserving compatibility with an existing legacy surface

## Runtime Boundary

- Explicit Codex and Claude Lens sessions must ingest exactly one MidTerm-owned canonical runtime stream, and that stream must come through `mtagenthost`.
- `mtagenthost` is the only place where provider-specific transport, protocol parsing, provider-specific semantics, and event canonization belong for Lens.
- `mtagenthost` must reduce provider-specific structured events into one provider-neutral canonical Lens history model that is a capability superset of the supported provider surfaces.
- `mtagenthost` must own the canonical in-memory Lens history for a session. `mt` should broker access to that history, not build and own a second competing canonical reducer.
- Lens sessions must be immune to `mt` restarts. Restarting or replacing `mt` must not destroy, reset, or orphan the canonical Lens session state for an attached Codex or Claude Lens runtime.
- All canonical Lens session state needed for recovery after an `mt` restart must live in the owning `mtagenthost` instance for that Lens session.
- The intended runtime cardinality is one dedicated `mtagenthost` process per explicit Codex Lens session or Claude Lens session.
- Canonical Lens history must be optimized for human consumption. Transport noise, fluff, superseded chatter, and non-view-affecting provider detail should be discarded as early as possible to save memory.
- If `mtagenthost` attach fails, Lens should surface that failure and remain unattached rather than switching to a second provider ingestion path with different behavior.
- The frontend should consume the same canonical MidTerm Lens concepts regardless of provider and regardless of the provider's raw wire shape.

## Architecture Contract

Specified architecture:

1. Codex and Claude emit structured events with provider-specific formats and semantics.
2. `mtagenthost` canonizes those provider events into one linear in-memory history of canonical Lens items.
3. That canonical history is index-addressable and human-oriented. Each item has a type that dictates frontend rendering behavior.
4. `mt` brokers access to that history. It is a bridge layer, not the canonical history owner.
5. The frontend measures the viewport and fetches only the history items needed to render the visible region plus a modest margin.
6. The frontend forgets items that move out of view, while keeping enough nearby history resident that scrolling back roughly 30 to 70 items remains instant.
7. Restarting `mt` must not interrupt or erase an active Lens session. `mt` must be able to reconnect to the still-owning `mtagenthost` and resume brokering the same canonical history.

The canonical history contract must satisfy the following:

- history fetches are index-window fetches, not provider-event replays and not pixel-window fetches
- the essential fetch shape is `give me items startIndex..endIndex` or an equivalent `startIndex + count`
- fetch responses must include the returned absolute item indexes plus the current overall history count
- the frontend should be able to virtualize from count plus item windows without depending on backend-owned pixel spacer estimates
- canonical items should be self-renderable for the normal Lens UI path
- canonical items may intentionally summarize or omit raw provider payload detail if that detail is not intended for direct viewing
- canonical history should include special interactive item types when the agent expects dedicated UI treatment rather than plain text rendering
- one required draft interactive type is an `interview` item where the agent emits a list of questions and the frontend renders a dedicated response widget
- canonical recovery after an `mt` restart must come from `mtagenthost` state, not from rebuilding browser-visible history inside a fresh `mt` process from partial browser caches

## Core Principles

### 1. Stable chronology

- The history/timeline must be strictly chronological and visually stable.
- New items must append in a predictable order.
- Existing items may update in place while streaming, but must not jump above or between older completed items unless the underlying turn/item identity itself is wrong.
- Reordering bugs are correctness bugs, not cosmetic issues.
- Future updates must not mutate an already-rendered older row into a different row identity. When a visible item's rendered shape changes materially, Lens should replace that item's DOM node at the same canonical position instead of reinterpreting a past node for new content.

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
- Lens history transport must be count-and-index based. The browser should know total history count and fetch absolute history windows by index.
- The backend history contract must not require the browser to depend on backend-owned pixel spacer estimates for unseen history.
- The frontend owns viewport measurement, row measurement, and DOM virtualization behavior.
- Browser-resident Lens history should stay bounded to the visible working set plus a modest nearby margin instead of accumulating the full session scrollback in memory.
- The browser should treat Lens history as a viewport over `mtagenthost`-owned canonical history, not as a durable full-history cache.
- Different browsers viewing the same Lens session may hold different local windows and scroll positions without changing the canonical history.
- Older-history fetches should retrieve only the requested canonical slice plus total-count metadata, not replay the full raw provider event stream.
- When a Lens surface becomes hidden or inactive, its rendered history DOM should be dropped and its retained browser-side history should collapse toward a small nearby slice while the runtime keeps ingesting canonical state.

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
- When a Lens surface is reopened, reactivated, or restored after being hidden, it should re-enter at the live edge in follow mode by default unless the user is in the middle of an explicit older-history navigation flow.
- When the user seeks into older history, Lens should expand or shift the history window deterministically without resetting the live Lens session or replaying the entire history from scratch.
- When older-history paging prepends more canonical rows, Lens should preserve the reader position by anchoring to a stable visible history row identity and restoring against that row's real DOM offset, not by summing guessed row heights.
- Passive rerenders must not clear an active text selection inside Lens. If the user is selecting or holding a non-collapsed selection in the history pane, Lens should defer non-forced DOM replacement until that selection is cleared.

### 11. Terminal-font monospace usage

- Diffs, code blocks, command output, script output, tool text, file-change output, and similar machine-oriented content should use the configured terminal font stack.
- Lens must not invent a separate monospace language that diverges from the terminal's configured typography.

## Visual System

### Typography

- Use at most 2 to 4 font styles across the Lens surface.
- Reserve stronger styles for true hierarchy boundaries only.
- Favor readable body text and restrained metadata styling.
- In Codex Lens, user and assistant prompt bodies should follow the configured terminal monospace stack and terminal font size so prompt and response text align with command-oriented work.

### Containers

- Default history rows should not use card-heavy presentation.
- Use lightweight blocks with strong spacing and alignment.
- Borders, fills, and backgrounds should be sparse and purposeful.
- Only exceptional states such as approvals, errors, or diff summaries may justify stronger containment.
- Lens must own the visible backdrop of its active surface. When terminal transparency is configured as fully opaque, Lens should sit on an opaque terminal-toned underlay so wallpaper or hidden sibling panels cannot bleed through the active Lens surface.
- Lens pane background/transparency should follow the terminal transparency model, not the surrounding generic UI shell transparency model.

### Color and emphasis

- Color should communicate meaning sparingly.
- Persistent accent color usage should be limited to active/ready/progress states and important calls to action.
- Avoid rainbow status noise across history rows.

### Motion

- Streaming and item updates should feel alive but subtle.
- Use restrained transitions for stream growth, tool state changes, and ready-state changes.
- Avoid layout thrash and avoid motion that causes the eye to lose reading position.

## History Model

### Raw Event Reduction

- Codex and Claude may emit radically different structured event shapes and semantics.
- `mtagenthost` must canonize those provider-specific events into one provider-neutral canonical history model before the web UI sees them.
- Provider runtimes may emit vastly more data than Lens should render directly.
- Raw provider traffic is not the Lens UX contract. Canonical history is.
- The Lens timeline should preserve meaning, identity, and operator comprehension, not raw wire completeness.
- Giant command outputs, giant file bodies, repetitive progress chatter, and transport-level event spam should be summarized, windowed, or suppressed before they reach canonical history.
- Lens should make it obvious when content is intentionally windowed or summarized by using stable omitted-line markers, bounded previews, or disclosure affordances.
- Raw provider inputs are transient reducer inputs, not retained Lens history.
- If content is not meant to be shown later, or needed to determine what is shown later, it should be dropped instead of preserved in a hidden Lens data layer.

### Canonical History Shape

- Canonical Lens history is one linear sequence of canonical history items.
- That sequence must be addressable by absolute index and current total count.
- History fetches must operate on index windows rather than provider event streams.
- Canonical history storage should be designed so the frontend can ask for `startIndex..endIndex` style windows and receive those items plus the current history count.
- The canonical history should not require the frontend to understand provider-specific event semantics in order to virtualize or render.
- Each canonical item type must fully determine the frontend renderer path for that item.
- Canonical item types should cover at least:
  - user message style items
  - assistant message style items
  - tool / machine output items
  - diff / file change items
  - request / approval items
  - system / notice items
  - interview items

### Interview Items

- Lens must support special canonical interactive history items where the agent expects a dedicated frontend widget rather than plain text rendering.
- One first-class draft interactive type is an `interview` item that carries a list of questions.
- The frontend should render `interview` items with a dedicated widget-oriented presentation rather than flattening them into ordinary assistant markdown.
- Provider-specific question/request semantics may map into that canonical item type, but the frontend should only consume the canonical item contract.

### Ordering

- Turns and items must render in canonical order from the backend identity model.
- If a user row for an older turn materializes late, the backend must still promote that user row to the start of its turn instead of leaving it below newer rows that happened to be created first.
- A streaming assistant response should update its existing row in place.
- Tool updates should attach to the owning turn and item instead of spawning visually disjoint duplicates.

### User messages

- User prompts should be visually distinct but compact.
- They should anchor the start of a turn without dominating the screen.
- Repeated rendering of the same user turn is forbidden.
- No Lens history row should right-align its header labels or timestamps. Quiet role labels, kind badges, and any timestamp/meta text should stay left-bound and wrap naturally when space is tight.
- In Codex Lens, user rows should place their quiet role label and timestamp above the message body, not below it.
- In Codex Lens, assistant rows should place any optional timestamp above the message body when that preference is enabled, but should default to no repeated assistant timestamp.
- In Codex Lens, the quiet role label should remain on user rows, while assistant rows should omit a repeated `Agent` label when the row is otherwise plainly identifiable as assistant output.
- In Codex Lens, the first assistant message row of a new turn should show a quiet `Agent` badge so the answer start is visually distinct from the preceding user prompt, but later assistant rows in the same turn should omit that repeated badge.

### Assistant output

- Assistant content is the primary reading surface and should have the clearest typography.
- Streaming text should appear incrementally in place.
- The assistant row should not visually reset between deltas.
- When the final assistant item lands for a turn that already has streamed assistant text, Lens should reconcile that into one settled assistant row rather than showing both the streamed row and a second final duplicate.
- The timeline should use one trailing busy bubble as the sole animated activity indicator while the provider is actively working.
- That trailing busy bubble may carry the only live progress label in the history lane. Completed or in-progress status words must not be repeated inside per-row timestamp/meta text.
- When the provider exposes a live in-progress task/tool/reasoning detail label, the trailing busy bubble should display that provider-supplied text. User-prompt text and assistant-message text must not populate the busy bubble. Only fall back to a generic `Working` label when no meaningful live provider label is available.
- While a turn is active, that busy bubble should also show a muted wall-clock duration counter plus a quiet `(Press Esc to cancel)` hint immediately after the animated label, not detached against the far edge of the pane.
- The busy-label animation should sweep smoothly left-to-right and back again without a visible jump reset, and it should remain a pure CSS animation rather than relying on JavaScript timing.
- The busy-label text highlight should mirror at the right edge and travel back left through the same letters before beginning the next cycle, rather than snapping immediately from the right edge back to the first letter.
- When the turn settles back to the user, Lens should append one muted inline duration note such as `(Turn took 1m 4s)` into the history instead of leaving the elapsed time only in transient chrome.
- That turn-settled duration note should render as a quiet near-full-width end-of-turn marker, with horizontal rule segments on both sides of the centered text and only a small gap around the label, rather than as ordinary paragraph text.
- Per-row fake activity indicators should not linger inside older history rows.
- When the final assistant item lands, the row should settle into its completed state without a hard replace, jump, or scroll jolt.

### Tool activity

- Tool activity should be visible, but compressed by default.
- Starts, progress, completion, and failure should read as one evolving activity line or block where possible.
- Raw transport noise must not leak into the UI.
- Runtime/system notices should strip raw ANSI/control bytes and de-duplicate repeated message/detail fragments before they render in Lens history.
- Provider startup/runtime state notices that MidTerm understands, such as Codex MCP server startup-status updates, should map into quiet canonical `Agent State` system rows instead of falling through as unknown-agent tool rows.
- Provider CLI/runtime error blocks that arrive outside the normal assistant stream, including multi-line stderr startup failures and deprecation errors, should map into canonical `Agent Error` notice rows with stronger red emphasis than ordinary system rows.
- When Codex or Claude emits an unknown structured provider event, MidTerm should preserve it as a canonical diagnostic history item instead of silently dropping it.
- Those fallback unknown-agent rows may render raw provider method/payload detail, but they must remain clearly marked as unknown MidTerm fallback output rather than pretending to be a first-class mapped concept.
- Lens should expose a user setting to hide or show those unknown-agent fallback rows, and the default should favor showing them so new provider capabilities are inspectable before MidTerm ships a dedicated mapping.
- Tool, reasoning, plan, diff, request, and system rows should share one restrained structural language instead of mixing rail markers, unrelated borders, and unrelated card treatments.
- Long machine-oriented bodies such as command output, file-change output, reasoning blocks, and similar tool-style details should collapse into unfoldable disclosure panels by default once they are stable.
- Collapsed tool-style panels should expose a short preview plus line-count context so the user can scan relevance before expanding.
- Tool commands, command output, file paths, and other machine-oriented detail should use the configured terminal monospace stack.
- Command/file-read noise should be summarized for screen use instead of dumping full raw terminal-like output into Lens history.
- File-read commands should surface the path and a compact excerpt policy, not the full file body.
- Generic command output should prefer compact head/tail or tail-oriented summaries with omitted-line markers over unbounded dumps.
- Command-execution rows should render in a console-like `Ran …` form with lightweight syntax coloring: command name, flags/parameters, quoted strings, and shell operators should be visually distinct without turning the row into a card.
- When command output is available immediately after a command-execution row, Lens should fold up to 12 tail lines beneath that same `Ran …` line in muted terminal monospace instead of rendering a second noisy standalone output row.
- Once command output has been folded into a command-execution row, that compact tail must remain attached to that historical command even after later commands and outputs arrive in the same turn.
- Folded command-output tails should remain raw terminal text. Do not apply assistant-style semantic enrichment, clickable file-path decoration, or inline image previews inside those noisy tail lines.
- When the backend already materializes a command-output history row that contains both the command header and compact output window, Lens should normalize that row directly into the same persistent `Ran …` presentation instead of depending on adjacency with a separate command-execution row.
- Canonical command-output history rows should preserve the command header as structured command metadata rather than forcing the browser to recover it from a truncated body.
- Omission markers such as `... earlier output omitted ...` or `... N earlier lines omitted ...` are output-tail metadata, not command headers, and Lens must never render them as the `Ran …` command text.
- Once a `Ran …` command row has been surfaced in the current Lens history window, later partial updates or transient backend shape changes must not downgrade it back into a generic tool row, strip its folded tail, or drop it from that materialized history slice.
- Repetitive tool lifecycle chatter should collapse into the owning tool row instead of materializing as many visually separate history rows.
- Command-execution rows and diff rows should not repeat timestamp meta. Those artifact rows should read like quiet console output, not timestamped chat turns.
- Command-execution rows should remain fully flat. Do not wrap them in bordered cards, bubble shells, or inset containers that break text selection or console-like continuity.
- Lens should not draw decorative card outlines, rounded shells, or inset border treatments around machine-oriented history rows. Tool, reasoning, plan, diff, and command artifacts should stay flat unless a future design contract explicitly reintroduces structure.
- Markdown paragraph and list spacing should be dense and terminal-like. Simple line breaks and bullet lists must not create chat-style empty-line gaps between adjacent lines.
- Blank-line paragraph breaks in assistant markdown should stay much tighter than prose defaults, roughly closer to a half-line pause than a full chat-paragraph gap.
- Assistant markdown should model those blank-line pauses explicitly as compact gap markers in the rendered structure instead of relying on ordinary paragraph margins to approximate dense terminal spacing.
- Bullet and numbered lists should stack compactly, with minimal vertical slack between adjacent items and between the surrounding text and the list block.
- List markers must stay fully visible inside the rendered assistant markdown block. Overflow containment in Lens must not crop bullet or number markers.
- Current Codex Lens markdown gap markers should stay very tight, roughly a quarter-em pause per blank line rather than the older taller half-em spacing.
- Streaming assistant text should render through the same markdown surface as settled assistant output so lists, headings, and dense paragraph spacing stay stable while the row grows in place.
- If settlement later adds higher-confidence file-link or image-preview enrichment, that refinement must preserve the same markdown-rendered body instead of downgrading the row to raw plain text.
- Markdown tables should stay left-anchored and use intrinsic width when their content is narrow, rather than stretching across the whole history lane by default.
- Assistant markdown tables should expose compact per-column sort and filter controls in the header row so dense comparison output can be reorganized in place.
- Fenced CSV blocks in assistant markdown should render through that same interactive table treatment so tabular data is readable without raw code-block noise.
- Finalized assistant messages may receive a post-settlement enrichment pass, but streaming assistant text must remain raw, low-latency text with no late token chrome injected mid-stream.
- That finalized assistant enrichment should stay restrained and high-signal: bare URLs should become proper links, file paths should become clickable file references, likely git commit hashes should be clickable, and existing local image references may surface as compact thumbnail previews beneath the message.
- Image previews should preserve the full image bounds inside a bounded frame instead of center-cropping portrait screenshots or photos.
- Assistant-only semantic tinting should remain subtle. Numbers and plain-text table outline characters may be muted to improve scanability, but those accents must never overpower the message body or leak into command, diff, or other machine-oriented artifact rows.
- Codex runtime bookkeeping notices such as context-window updates and rate-limit updates should not render as history rows. Lens should interpret them as session telemetry instead of timeline content.
- Lens should expose that telemetry in a compact hovering stats display that stays out of the reading flow while surfacing context-window usage as a percent-of-limit summary plus accumulated session input/output token totals.
- If the provider notice only exposes cumulative session token totals rather than reliable live context occupancy, Lens must not fake a context percent; it should fall back to the window limit plus session in/out totals instead.

### Plan-mode questions and approvals

- Requests that require user action must stand out clearly from passive history content.
- They should read like the next required interaction, not like another log entry.
- The composer and action affordances should align with that state.

### Diffs and file changes

- Diffs should be surfaced as first-class work artifacts, not buried in generic tool logs.
- Unified diffs should render as actual diffs with added and removed lines visually separated by green/red treatments, not as undifferentiated plain monospace blocks.
- Diff rows should stay expanded by default instead of hiding behind the generic machine-output disclosure treatment.
- Lens should trim non-essential unified-diff preamble noise where possible and prioritize the file header plus actual hunk content.
- When unified diff hunks provide old/new coordinates, Lens should show a subtle old/new line-number gutter beside the diff text.
- That diff line-number gutter should stay structurally consistent across context, removed, and added lines; do not switch between doubled columns, stretched single columns, or other per-row numbering layouts that make the gutter look accidental.
- That gutter should leave clear visual separation between the old and new number lanes; context rows may show both coordinates, but the lanes must not feel visually crammed together.
- Diff file headers should read like console work artifacts, preferring `Edited {full path}` above the hunk blocks rather than raw `diff --git` preamble.
- Extremely large diff bodies should remain bounded in the timeline: render the first 200 visible diff lines, then end with an ellipsis marker instead of dumping the full tail.
- File-oriented information should use monospace sparingly and preserve readability.

## Composer And Ready State

- The composer is the primary action control for Lens sessions.
- The composer textbox should remain visibly larger than surrounding automation chips, status pills, and quick-setting controls; the dock must read as one system, but the prompt should still dominate.
- The single-line composer row should align on a shared visual centerline with its adjacent send and utility buttons, and the dock should use equal vertical spacing between the pane edge and each visible dock row.
- Lens and Terminal should now share one adaptive footer dock language instead of stacking unrelated bars beneath the active pane.
- When input is visible, the primary smart input row must always be the first row directly beneath the active pane.
- Lens quick settings should live in the dock status rail rather than as a separate detached manager strip.
- That Lens status rail should stay intentionally small and session-oriented.
- Normal terminal smart input should reuse the same dock shell while keeping Lens-only runtime controls out of ordinary terminal sessions.
- If the user queues follow-up work from the shared Command Bay, Lens should render that queue as a compact vertical stack directly above the composer instead of inventing a separate floating queue surface.
- Lens queue ownership belongs to MidTerm, not the browser. Queued Command Bay prompts and queued Automation Bar items must survive browser disconnects and drain only when the current turn has returned control to the user.
- If the shared Command Bay queue is empty and the active session can accept work immediately, MidTerm should fast-track that submission directly to the runtime instead of briefly rendering a one-item queued row before sending. For Lens sessions this means the turn has returned to the user; for Terminal sessions this means the session is idle enough to pass the cooldown heat gate.
- On desktop, Lens quick settings should read as a low-clutter translucent control rail rather than a full-width form.
- The model quick setting should use a provider-scoped populated list, while still preserving any current non-preset model already active in the session or draft.
- Command Bay controls should use one shared visual language for typography, spacing, radius, border treatment, and hover states; avoid mixing glowy icon buttons, flat chips, and separate pill styles in the same dock.
- MidTerm's dock chrome should stay relatively boxy: tighter corner radii, compact control heights, and restrained padding rather than oversized capsule pills.
- Prompt-side utility buttons, automation chips, quick-setting pills, and status controls should all use restrained tonal surfaces instead of individual glow or shadow gimmicks.
- On mobile, Lens should keep model/effort/plan awareness always visible in the dock status rail and may reveal the full editable quick-settings surface as a compact sheet from that status row.
- When desktop width becomes constrained enough that the inline quick-settings rail would overflow, Lens should fall back to that same summary-plus-sheet pattern instead of letting controls spill off screen.
- Manager automation should occupy at most one dock row and one visual line, with overflow or truncation behavior instead of wrapping into a second toolbar band.
- The shared Command Bay / adaptive footer must reserve its own visible rails and panels beneath the active pane instead of floating over Terminal or Lens content.
- Only the prompt textbox's extra multiline growth may expand upward over the pane as overlay chrome; the rest of the Command Bay must remain pane-reserving once the collapsed dock reserve is established.
- On Android and iOS, the Command Bay must remain visible above the on-screen keyboard; if vertical space tightens, the dock should compress or scroll internally while keeping the prompt row and status awareness reachable.
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
- Lens sessions that were launched from a bookmark may expose a small provider-native `Resume` action inline with the quick-settings rail, immediately after the permission control.
- That `Resume` action must open MidTerm's provider resume picker and create a new Lens session bound to the selected provider conversation; it must not silently swap the current Lens session to a different provider thread in place.
- Lens composer attachments should stage inside the composer itself as removable chips instead of triggering an immediate turn on selection.
- Lens should allow attachment-only turns and should treat repeated paste or repeated `+` actions as additive until the user explicitly removes a chip or sends the turn.
- Clipboard paste inside the active Lens composer should capture browser-exposed files/images into those chips while leaving plain-text paste behavior intact.
- Image attachments staged in the Lens composer should also insert stable inline reference tokens such as `[Image 1]` at the caret so the prompt text can refer to those attachments explicitly.
- Those inline reference tokens must behave atomically: caret placement may land only before or after the token, partial selection should expand to the full token, and deleting a token must also remove its staged composer chip.
- Large pasted text blocks that would overwhelm the composer should stage as text references instead of raw inline text, using tokens such as `[Text 1 - 37 lines - 594 chars]` plus removable chips that open the full staged text in the file viewer.
- A subtle ready indication must show when the provider runtime is connected and can accept input.
- Ready-state presentation should be understated, always visible, and never confused with history content.
- Sending, streaming, awaiting approval, and awaiting user input should each have clear but low-noise state treatment.
- In Lens sessions, plain `Esc` anywhere inside the active Lens surface should interrupt the active turn instead of sending a literal terminal escape key.
- The busy-indicator hint `(Press Esc to cancel)` implies a surface-wide shortcut, not a composer-only shortcut.
- If the user queued follow-up Lens turns while a turn was still running, the first `Esc` should let that queued work drain next, and a second `Esc` should cancel the remaining queued drain.

## Performance Rules

- Streaming must not cause full history/timeline rerenders.
- Live Lens transport should flow as `provider event -> mtagenthost canonization -> mt bridge -> frontend history window fetch / delta -> visible row patch`.
- Item updates should target stable DOM anchors keyed by canonical identity.
- Virtual scrolling must remove old items from the live DOM when the history becomes large.
- Rich tool/log items should support collapsed rendering by default, but working diffs should stay expanded with a bounded visible body.
- High-volume provider chatter should be reduced before transport so the browser receives canonical history deltas, not raw-event floods.
- The browser should request history as explicit index windows and should not receive arbitrary unseen history by default.
- Multiple browsers attached to one Lens session should share the same canonical history while independently fetching only the windows each browser currently needs.
- Re-entry and reconnect should prefer a latest anchored window plus live follow mode by default; older-history windows should be fetched only after explicit user navigation.
- If the user is browsing an older window and off-window history mutations arrive, Lens should refresh that canonical window rather than pretending unseen history can be corrected from partial browser knowledge alone.
- The frontend should retain only the visible window plus a modest nearby margin. Once items move far enough out of view, they should be discarded from browser memory and certainly from the live DOM.

## Current Gaps

- not yet implemented: browser virtualization now carries forward observed row-height samples across previously seen windows at the current width bucket, but it still does not keep a richer canonical or long-run distribution model for highly heterogeneous off-window scrollbar accuracy
- not yet implemented: legacy `SessionLensHistoryService` usage still exists in some non-Lens-browser paths even though the Lens browser-facing canonical history path now comes from `mtagenthost`
- not yet implemented: older transport-era naming and `transcript` naming still leak through non-browser services, reducer internals, host-owned canonical state types, and some debug/test surfaces even though the active browser/websocket path is now history-first
- not yet implemented: interview interactions now render inline in the timeline with a dedicated request widget, but they are still modeled as request summaries plus request history rows rather than a fully separate canonical `interview` item type end to end
- not yet implemented: Codex interview/user-input is supported through a verified structured runtime contract, but Claude interview/user-input remains explicitly unsupported until MidTerm integrates a verified structured Claude contract instead of a guessed bridge

## Dev Diagnostics

- In dev mode, MidTerm should write one GUID-named Lens screen log per session under the normal MidTerm log root.
- The Lens screen log should be derived from canonical Lens history deltas, not raw provider transport payloads or frontend DOM scraping.
- Screen-log records should include the rendered-history facts needed to discuss the UI: stable history identity, kind, label, title, meta, body, render mode, and whether the body collapses by default.
- Lens dev diagnostics must not introduce a second retained raw-event history layer. The screen log is a derived canonical view aid only.

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
- implemented: when a visible history row changes materially, Lens now replaces that row node by stable key instead of mutating an older DOM node into a new future shape
- implemented: scroll-follow suppression while the user is away from the live edge, plus an explicit return-to-bottom control
- implemented: non-user layout growth and sizing changes no longer clear live-edge follow state by themselves; only explicit user scrolling moves Lens out of follow mode
- implemented: when a hidden Lens surface is shown again, whether by MidTerm tab reactivation or browser foreground return, it restores a fresh latest-history window and re-enters live-edge follow mode by default instead of preserving a stale mid-history scroll offset
- implemented: terminal-font monospace rendering for machine-oriented Lens content
- implemented: provider-stream-driven assistant rendering so partial assistant text can appear before the final provider message lands
- implemented: responsive Lens styling for mobile-sized layouts
- implemented: Lens-specific themed CSS tokens layered onto the existing MidTerm theme system
- implemented: i18n-backed MidTerm Lens labels, buttons, helper copy, ready-state text, and interruption text
- implemented: hidden/background Lens sessions may continue ingesting runtime state, but history DOM work is deferred until that Lens surface is visible again
- implemented: hidden/background Lens sessions clear rendered history DOM and compact retained browser-side history back to a bounded latest window without interrupting the live runtime
- implemented: Lens history is treated as a bounded browser-side view window over MidTerm-owned canonical history rather than as an unbounded full-history browser cache
- implemented: explicit Codex and Claude Lens sessions now route through `mtagenthost` as the single structured runtime boundary; `SessionLensRuntimeService` no longer falls back to a second in-process Codex runtime when host attach fails
- implemented: Claude Lens no longer injects or parses a MidTerm-invented XML user-input bridge in the active runtime path; unsupported Claude interview/user-input now remains unsupported instead of relying on guessed protocol behavior
- implemented: Lens retains canonical user-facing history rather than a hidden durable raw-event archive
- implemented: MidTerm-side Lens persistence now writes canonical reduced session state instead of appending provider-shaped event logs, while transient live event backlog stays bounded in memory only
- implemented: mouseup inside the Lens surface no longer routes through terminal focus reclaim, so drag text selection in Lens remains intact after the mouse button is released
- implemented: long non-diff machine-oriented Lens bodies collapse into unfoldable disclosure panels by default, with line-count and preview context for quick scanning
- implemented: Lens diff rows stay expanded by default, suppress non-essential unified-diff preamble noise where possible, and cap visible diff rendering at 200 lines plus an ellipsis marker
- implemented: Lens diff rows remove artificial blank spacing between lines and show old/new hunk line numbers when the diff provides them
- implemented: tool-style titles and bodies use the configured terminal monospace stack consistently
- implemented: dev mode writes one GUID-named per-session Lens screen log derived from canonical history deltas and render hints
- implemented: Lens uses one artificial trailing busy bubble while a turn is active instead of leaving per-row activity indicators running inside history entries
- implemented: command and file-read tool output is screen-summarized before it reaches both the Lens UI and the dev screen log
- implemented: command-execution tool rows now render as console-like `Ran …` lines with lightweight syntax highlighting and the configured terminal monospace stack
- implemented: immediate command output is folded into the command row as a muted up-to-12-line tail instead of always rendering as a separate noisy row
- implemented: folded command-output tails now stay raw terminal text without assistant-style file-path linkification or inline image previews
- implemented: provisional command-output rows now reconcile onto their canonical command/tool identity so folded `Ran …` tails remain attached after later item completion or later commands in the same turn
- implemented: command-output history rows now carry canonical command text separately from the truncated output body, so omission markers cannot be mis-promoted into fake `Ran ...` commands and compact tails keep their line structure
- implemented: command rows now stay on the dedicated flat `Ran …` presentation once normalized, preserving their folded tails across later partial updates and temporary shape regressions while that history window remains materialized
- implemented: raw provider/tool chatter is reduced into canonical history rows so the normal Lens timeline does not mirror full wire-level noise
- implemented: browser-facing canonical Lens history now lives in `mtagenthost`, with `mt` brokering history windows and history patches instead of rebuilding a competing canonical browser history reducer
- implemented: explicit Lens sessions now survive `mt` restart by reconnecting to the owning `mtagenthost` and reusing that host-owned canonical history
- implemented: Lens history transport between browser and backend now uses count/index history windows and canonical history patches rather than backend-owned unseen-history pixel spacer estimates
- implemented: `/ws/lens` no longer needs or serves the old browser-facing `snapshot.get` / `events.get` compatibility path; the active Lens browser transport is `history.window.get` plus live `history.patch`
- implemented: unseen-history spacer geometry is now estimated locally in the browser from total history count plus loaded-row estimates and measured row heights
- implemented: visible-row virtualization now prefers browser-measured row heights over static heuristics and keeps those measurements as the render window shifts
- implemented: browser-side virtual-range math now uses cumulative prefix-height layout math with binary-search index lookup instead of repeated linear spacer scans through the full retained window
- implemented: the browser now retains one bounded moving history window and shifts it by overlapping absolute index fetches instead of monotonically expanding the cached history while the user pages around
- implemented: retained browser history now recenters around the actual visible history range plus a bounded nearby margin rather than only paging by fixed top/bottom thresholds
- implemented: viewport-driven history refetch now trims retained browser history down to the visible range plus a bounded nearby margin instead of enforcing an extra fixed retained-window floor
- implemented: unseen-history spacer estimation now retains observed row-height samples across previously visited windows at the current width bucket instead of relying only on the currently loaded slice
- implemented: browser-requested history windows now include the current viewport width bucket so `mtagenthost` can return width-aware per-row height estimates instead of assuming one fixed desktop width
- implemented: older-history and newer-history window shifts restore scroll position from a stable visible anchor row and actual DOM offsets instead of summing estimated prepended row heights
- implemented: while Lens is restoring a backward-history anchor after a window shift, it temporarily keeps that fetched window materialized so browser scroll clamping cannot strand the viewport inside spacer-only black gaps before the anchor row is restored
- implemented: browser-requested history windows now carry a client-owned revision token through the websocket path so stale same-sequence window responses cannot overwrite a newer intended viewport after async refetches or resubscribe churn
- implemented: Lens scroll semantics now use explicit browser modes (`follow`, `browse`, `restore-anchor`) so upward user scrolls detach immediately while backward-history anchor restoration stays distinct from live-edge follow mode
- implemented: follow mode now also detaches on real upward viewport movement away from the live edge even when an embedded/nested browser misses the explicit wheel/touch intent marker, preventing stuck-bottom repinning loops
- implemented: the active-turn busy elapsed timer now updates only the existing busy-indicator label in place instead of forcing a full Lens history rerender, so idle sessions have no active bottom-pin loop and running sessions avoid timer-driven repin work
- implemented: retained-window sizing now prefers the browser's observed median row height when available, reducing unnecessary DOM retention for tall windows while still falling back to the conservative default estimate before measurements exist
- implemented: row-height measurements are now retained per viewport-width bucket and reused when the Lens pane returns to a previous width class instead of clearing all known measurements on resize
- implemented: visible Lens rows now stay under `ResizeObserver` measurement, and non-follow browsing captures/restores a layout anchor so late content reflow and viewport resize do not destabilize the reader position or virtual window selection
- implemented: when off-window canonical history changes arrive while the user is browsing older history, Lens now refreshes that window instead of silently leaving remote spacer geometry stale
- implemented: when a hidden Lens session returns to view while its cached browser window is still off the live edge, Lens now refreshes the latest window and rerenders immediately when hidden-history compaction finishes so the viewport does not strand the user inside spacer-only voids
- implemented: the active TypeScript Lens client and browser state now consume history-first window/patch types directly instead of normalizing live browser traffic back into the older snapshot/delta DTO shape
- implemented: assistant markdown now keeps single line breaks inside the same dense paragraph with simple line breaks, while blank lines still form real paragraph boundaries
- implemented: assistant rows now stay markdown-rendered while streaming and remain markdown-rendered after later turns begin, so settled replies do not visually fall back to plain text
- implemented: finalized Lens history rows now receive canonical C# file-mention enrichment before they reach the browser, so settled title/body/command text can render clickable file and folder references plus server-confirmed image thumbnails without a second browser-only resolution pass
- implemented: clickable Lens file and folder mentions now render as blue dotted-underlined links so file-oriented references stand out from surrounding prose and machine output
- implemented: assistant markdown blank-line gap markers now use a tighter quarter-em pause per blank line instead of the older taller half-em spacing
- implemented: assistant markdown lists now use in-box custom markers and counters with deeper indent so bullets and numerals stay visible inside the overflow-constrained Lens body
- implemented: assistant markdown tables now stay left-anchored at intrinsic width when narrow instead of always stretching across the full history lane
- implemented: assistant markdown tables now add compact per-column sort and filter controls directly in the header row
- implemented: fenced CSV code blocks in assistant markdown now render as the same compact sortable/filterable table treatment instead of raw code blocks
- implemented: Codex Lens uses a full-width left-anchored history/composer layout instead of the previous centered lane
- implemented: Codex Lens distinguishes user and assistant rows with quiet `User` and `Agent` labels rather than right-floating user bubbles
- implemented: Lens row metadata is timestamp-only; transient progress words no longer linger beside older user, assistant, tool, diff, or request rows
- implemented: Lens history headers no longer right-bind labels or timestamps; row badges and any meta text stay left-anchored across user, assistant, tool, diff, request, system, and notice rows
- implemented: the only animated history activity element is the trailing global busy bubble, now rendered as a rotating SVG triangle with a blue center dot instead of pulsing ellipsis dots
- implemented: user and assistant rows now use smaller metadata, slightly cooler user labeling/text, and a subtly different font treatment while preserving a shared left edge
- implemented: Codex Lens now keeps `User`/`Agent` labels and timestamps above the message body and trims that metadata treatment down another pixel for a quieter row header
- implemented: Codex Lens now keeps the quiet role label on user rows while omitting the redundant repeated `Agent` badge on assistant message rows
- implemented: the first assistant message row in each turn now restores a quiet `Agent` badge so the answer start stays distinguishable from the preceding user prompt without reintroducing repeated badge noise on later assistant rows
- implemented: assistant-message timestamps are now controlled by an Agent setting, default hidden, while user-row timestamps remain visible above the prompt body
- implemented: Codex Lens user and assistant prompt bodies now follow the configured terminal monospace stack and terminal font size instead of a separate agent-ui font treatment
- implemented: tool, reasoning, plan, diff, request, and system rows now share a more uniform low-chrome surface treatment instead of stacked left rails and mixed border patterns
- implemented: Lens diff rows render unified diff lines with dedicated add/delete/hunk/header styling instead of plain raw monospace text
- implemented: Lens diff rows now use console-style `Edited {path}` file headers and tighter green/red hunk blocks with line numbers
- implemented: Lens diff code lines now use one consistent old/new gutter shape across context, delete, and add rows instead of changing numbering layout per row type
- implemented: Lens and Terminal now share one adaptive footer dock shell with ordered primary/context/automation/status rails instead of separate smart-input and manager bars
- implemented: the dock reserves only its collapsed footer height; multiline input growth expands upward as overlay chrome instead of shrinking the active pane
- implemented: desktop Lens quick settings now live in the dock status rail as a compact translucent control line, while mobile keeps a persistent summary row and reveals the editable controls as a compact sheet
- implemented: Lens model quick settings now use provider-scoped populated lists instead of a freeform textbox, while preserving current non-preset models already present in session state
- implemented: constrained desktop Lens layouts now collapse quick settings into the same summary-plus-sheet pattern used on mobile instead of allowing the inline rail to run off screen
- implemented: bookmark-scoped Lens `Resume` now lives inside that quick-settings line as a low-chrome text action directly after `Permissions` instead of as a detached status control
- implemented: Lens Smart Input now stages file/image selections and clipboard files as removable composer chips, and the `+` / photo actions no longer auto-submit a Lens turn on selection
- implemented: Lens composer attachments now upload as soon as they are staged so image chips render from server-backed file URLs and survive browser refresh; clicking a chip opens the standard file viewer, and Lens send reuses those staged upload paths for mixed or attachment-only turns
- implemented: staged Lens image attachments now also insert stable atomic inline references such as `[Image 1]` into the composer text, and removing either the inline reference or the chip removes the other so prompt text can refer to specific images deterministically
- implemented: Lens now converts large plain-text pastes into staged text-reference chips and atomic inline tokens such as `[Text 1 - 37 lines - 594 chars]`, so oversized pasted content stays inspectable through the file viewer without flooding the composer textarea
- implemented: inline Lens composer references are UI-facing placeholders only; on send, Lens keeps semantic markers such as `[Image 1]` in the prompt, expands staged text references into appended full-text blocks, and preserves real non-text attachments separately so the runtime receives the actual content rather than only placeholder token text
- implemented: quick-settings state is MidTerm-owned and canonical, while Codex and Claude permission/runtime mappings stay in the C# host/runtime layer
- implemented: Lens quick-settings drafts stay sticky per session and reuse provider-level remembered defaults for recurring workflows
- implemented: provider-scoped remembered default Lens models are now persisted in MidTerm-owned settings and seed new Lens sessions, with Codex defaulting to `gpt-5.4` when no explicit stored model exists
- implemented: desktop Lens quick-settings menus are allowed to escape the compact rail without being clipped by the rail container
- implemented: Lens quick settings remain hidden unless the active session is an explicit Lens surface; ordinary terminal sessions and no-session empty states never show Lens-only quick controls
- implemented: Lens plain `Esc` now interrupts active Lens turns from the composer, touch-controller, focused Lens surface, and a capture-phase active-session shortcut that takes priority over popup or footer dismissal, and queued follow-up turns can be drained or canceled with repeated `Esc`, including during the turn-start submission gap
- implemented: when terminal transparency is fully opaque, active Lens sessions render over an opaque terminal-toned underlay so wallpaper and hidden sibling panels do not glow through the Lens surface
- implemented: Lens pane backgrounds and composer underlays now key off terminal transparency tokens rather than the generic UI transparency tokens
- implemented: Codex/Claude history rows now render with a flatter console-like surface and remove the remaining card/bubble chrome while the renderer is being hardened
- implemented: the trailing busy bubble now ignores in-progress user-prompt items for its label and phase-locks its CSS sweep to the turn clock so elapsed-time refreshes do not visibly restart the animation
- implemented: the trailing busy-label text highlight now mirrors at the right edge and travels back left through the word instead of snapping from the end back to the first letter
- implemented: the shared Command Bay queue now renders as a vertical stack above the composer and is backed by MidTerm-owned persistent queue state rather than browser-local Lens-only submission state
- implemented: explicit Lens sessions now drain one queued Command Bay item only after the current turn returns to the user, while Terminal sessions use backend-owned heat gating with rearm between queued items
- implemented: shared Command Bay prompt submissions now bypass the visible queue entirely when that queue is empty and the target session can accept work immediately, so idle Terminal sends and user-turn Lens sends do not flash a transient queued row before dispatch
- implemented: settled turn-duration notes now render as a quiet near-full-width horizontal end-of-turn marker with the duration label centered between rule segments
- implemented: runtime/system notice text is sanitized for ANSI/control-byte noise, de-duplicates repeated message/detail payloads, and system rows render with quieter metadata/body emphasis than the main conversation lane
- implemented: Codex MCP startup-status notifications now reduce into quiet `Agent State` system rows instead of generic unknown-agent fallback tool rows
- implemented: multi-line Codex stderr startup/deprecation failures now reduce into single red `Agent Error` notice rows instead of separate generic warning lines
- implemented: runtime stats now suppress bogus context percentages when Codex reports cumulative token totals, falling back to the window limit plus session in/out totals instead of displaying impossible values
- implemented: request-backed interview interactions now render inline in the history timeline with a dedicated question-and-answer widget instead of being flattened into plain body text or composer-only interruption chrome
- implemented gap: canonical interactive request/question flows now have a dedicated frontend interview widget, but the backend model still represents them as request summaries rather than a first-class canonical `interview` item type

Still mandatory after this work whenever Lens evolves:

- keep this section current
- add new fundamentals here when they become real feature behavior
- document temporary violations instead of letting the implementation and spec drift apart
