# Read Aloud — pivot from selection bubble to turn footer

## Why

The project owner:

> "i would accept the button in the footer as discussed, just speaking the message
> after the last tool call should be enough"

The shipped approach anchors a floating speaker button to a live text selection. That
was web/Electron only — React Native exposes no JS API for the current selection — and
it carried two open Greptile P1s about selected text crossing daemon boundaries.

A footer button drops all of it: no anchoring, no placement, no selection to leak.

## Scope

Replace, don't add. The selection bubble goes.

| File                                  | Lines | Fate                                             |
| ------------------------------------- | ----: | ------------------------------------------------ |
| `use-selection-anchor.web.ts`         |   410 | delete                                           |
| `read-aloud-selection-bubble.web.tsx` |   398 | delete                                           |
| `read-aloud-placement.ts`             |   166 | delete                                           |
| `read-aloud-placement.test.ts`        |   152 | delete                                           |
| `read-aloud-selection-bubble.tsx`     |    12 | delete (native `return null` stub)               |
| `read-aloud-store.ts`                 |   185 | keep, one change (below)                         |
| `read-aloud-audio.web.ts` / `.ts`     |   100 | keep as-is                                       |
| protocol / server / client            |     — | keep as-is — the daemon contract does not change |

~1,138 lines deleted. Both Greptile P1s live entirely in deleted files, so they are
resolved by removal rather than by a fix.

## What ships

A speaker button in `AssistantTurnFooter`, next to the copy button
(`packages/app/src/components/message.tsx:663`). Press to hear the turn's closing
message; press again to stop.

### 1. The text: stop at the last tool call

`collectAssistantTurnContent` (`agent-stream/strategy.ts:162`) walks the turn backward
and breaks only on `user_message`. It steps _over_ `tool_call` items, so it returns
every prose block in the turn — including narration before the first tool.

Add a sibling `collectAssistantTurnSpeech` that also breaks on `tool_call`. It belongs
in the strategy, not at the call site: traversal direction is
`config.assistantTurnTraversalStep` (±1), because native renders an inverted list.

This is the only genuinely new logic in the pivot.

Markdown is **not** a problem: `sanitizeTextForReadAloud`
(`server/speech/read-aloud-text.ts`) already strips fences, HTML-like tags, link URLs,
and inline markers server-side. Every text path gets cleaned, not just selections.

### 2. The store: name the speaker

`read-aloud-store.ts` is a module-level singleton — one read at a time app-wide. That
was fine for a single bubble. With a button per turn, every footer subscribes to the
same snapshot and they would all render "speaking" at once.

Add an owner to the snapshot: `startReadAloud({ client, text, ownerId })`, and
`ReadAloudSnapshot.ownerId: string | null`. A footer shows the stop state only when
`snapshot.ownerId === thisTurnId`. Starting a second turn's read supersedes the first,
which the existing `generation` counter already handles.

Use the assistant item id as `ownerId`.

### 3. Host binding

Keep the invariant the selection version landed: speech goes to the route's host, never
another paired daemon. `useReadAloudServerId` is currently private to the bubble file —
lift it into `read-aloud/use-read-aloud-host.ts` and delete the bubble.

`resolvedServerId` already exists in `agent-stream/view.tsx:364` but is **not** passed to
`TurnFooter`. Either thread it through
`TurnFooter → CompletedTurnFooterRow → CompletedTurnFooter → AssistantTurnFooter`, or
keep deriving it from the route. Prefer threading — it is explicit, and the footer
already takes a `host` prop (note: that prop is a _layout_ grouping, `TurnFooterHost`,
not a server; do not overload it).

### 4. Platform gating

Native audio is a stub: `read-aloud-audio.ts` exports `isReadAloudAudioSupported = false`
and `playReadAloudSegment` throws. The button would render on iOS/Android and produce
silence.

Gate the button on `isReadAloudAudioSupported && hostSupportsReadAloud`. Platform scope
stays web + Electron, unchanged from today. Native audio is a follow-up — and now a
reachable one, since nothing about the footer button is web-specific.

The footer is already assistant-only and completed-turn-only (`layout.ts:120` returns
null while running), and it is not hover-gated, so the button is simply always visible.

## Tests

- `collectAssistantTurnSpeech` — text after the last tool call; a turn with no tool calls;
  a turn ending in a tool call with no trailing prose (expect empty → button hidden);
  both traversal directions.
- `read-aloud-store` — `ownerId` set on start, cleared on stop, superseded on a second
  start. Extend the existing `read-aloud-store.test.ts`.
- Delete `read-aloud-placement.test.ts` with its subject.

## Verification

Typecheck, lint, format, the touched test files, then the real app: press the button,
confirm audio and the idle → speaking → idle transitions.

Assert on the artifact, not the label. The last session's mistake was reading a state
machine going idle → stop → idle as success when a swallowed error was driving it and no
audio ever reached the output. Instrument `AudioContext` and check buffer peaks.

## Evidence

Playwright stills of idle / loading / speaking / stopped, plus a screen recording
converted to GIF, published to the PR. A silent GIF cannot show the feature working —
pair it with the measured buffer peaks.

## Delivery

New commits on `text-selection-speech-modal`, PR
[#2675](https://github.com/getpaseo/paseo/pull/2675). The PR description needs a rewrite,
not an edit: it currently documents the selection feature end to end.
