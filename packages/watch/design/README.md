# Paseo Wear OS — design

`watch-mock.html` is the original static mock (fake data, Paseo dark tokens). Open it in a
browser; the voice screen animates streaming partials and running status dots pulse.

**The mock is no longer the source of truth — the app is.** It has been built and verified on
a Wear OS 5.1 emulator; see the parent [README](../README.md). Where the two disagree, the app
wins. Two places they knowingly disagree:

- **The mock was ~40% denser than Wear typography allows.** At 450×450 / 320dpi (density 2.0),
  the mock's 13px type maps to about 9sp, well under Wear's legibility floor. The app uses
  13sp/10.5sp with 46dp list chips, which fits 3½ rows rather than the mock's 4. Don't "fix"
  the app to match the mock here.
- **Project icon colors differ.** The mock hand-picked emerald/orange/sky; the app runs the
  real `projectKey` hash, so `paseo` is violet and `website` is sky. The app is correct.

Also learned on device: `ScalingLazyColumn` centers its first item by default, which spends the
top third of the screen before anything renders. Every list here passes `autoCentering = null`.

## Information architecture

Paseo's model is **Project → Workspace → Agent session** ([glossary](../../../docs/glossary.md)).
The watch respects that hierarchy but collapses every step that isn't a real choice.

```
Workspaces  ──tap──▶  1 agent   ──▶ Agent
                      0 agents  ──▶ Voice prompt (new agent in this workspace)
                      2+ agents ──▶ Agent picker ──▶ Agent
```

The agent picker exists **only** for ambiguous workspaces. The common case — one agent in a
workspace — never sees it.

### Naming on each surface

Mixing these up was the first mistake this mock made, so it's written down:

| Surface       | Primary line             | Secondary line                                 |
| ------------- | ------------------------ | ---------------------------------------------- |
| Workspace row | workspace name (`main`)  | single agent status, or `3 agents · 1 running` |
| Agent row     | provider (`Claude`)      | status + age + short intent                    |
| Agent detail  | workspace name in header | provider · status · age                        |

Worktree-backed workspaces carry the mnemonic names (`jubilant-wombat`), so those are
**workspace** labels, never agent labels.

### Project identity

Every workspace row, and every detail header, carries the project icon: a colored rounded
square with the project initial. Color derives from `projectKey` exactly as the app does
(`packages/app/src/utils/project-icon-color.ts`) so a project looks the same on wrist and phone.

The status dot rides the **corner of the project icon** on list rows and aggregates the whole
workspace (needs-input > running > idle). One glyph carries project, identity, and state.

## Sort order

Needs-attention first, then running, then idle. On a 450px screen the top two rows are all
most users will read, so they have to be the ones that matter.

## Agent detail: a conversation, read from the bottom

The agent screen is a `ScalingLazyColumn` laid out as a chat log:

```
   project icon · workspace name        ← compact header
   ● Claude · running 12m               ← status line
   ─────────────────────────────
   earlier history on your phone        ← only when truncated
   …oldest transcript entry…
   …
   …newest transcript entry…
   ─────────────────────────────
             (Reply 52dp)               ← actions live at the END of the list
         (Type 38dp) (Stop 38dp)        ← satellites, second row
```

**It opens at the bottom.** That is the whole design. The newest turn and the Reply button
are what you get without touching the crown; the crown scrolls _up_ into the backlog only
when you want it. Anchoring at the top — the obvious thing — would put the oldest turn under
your eyes and the actions off-screen, which is exactly backwards for a triage surface. The
list is built as a row list before it is emitted so the "scroll to the last index" call can't
drift out of sync with what was actually rendered.

Kinds are separated by **weight, not labels**. A `You:` prefix on every other row spends a
line of a 450px screen restating what the styling already says:

| Kind        | Treatment                                                                      |
| ----------- | ------------------------------------------------------------------------------ |
| `assistant` | Bare, full-bleed, `foreground` at 12sp — the thing you are actually reading    |
| `user`      | Inset 22dp in a `surface2` bubble at 11.5sp — context, not news                |
| `tool`      | One line, monospace, 10sp `foregroundExtraMuted`, ellipsised, never wraps      |
| `error`     | `surface1` card with a `destructive`-tinted border, `destructive` text at 11sp |
| unknown     | Muted plain text — never dropped; see the parent README                        |

A tool line that wraps is a tool line pretending to be worth reading, so it is hard-capped at
`maxLines = 1`. Before any transcript arrives, the old 3-line summary card stands in its
place — with no spinner, because against a phone too old to answer a transcript request that
card is the permanent state, not a loading step.

## Voice and typing

**Reply _is_ the mic.** One tap on the agent screen and you are talking; the recognized string
goes straight to the agent. There was a composer screen in between — mic, keyboard, and three
canned replies — and it made the common case two taps to reach a button that was already on the
previous screen. Removing a screen is the fix; making the first tap do the likely thing is the
principle.

**Mic** is `ACTION_RECOGNIZE_SPEECH` — on-device, offline, free. It gets the accent color and
the biggest tap target.

**Typing** is Wear's remote input activity (`RemoteInputIntentHelper`), which opens the system
input picker: keyboard, handwriting, emoji, voice. It used to be the recognizer sheet with a
keyboard hint, which made typing a tap _inside_ the voice flow rather than a peer to it. It is
a peer now in the literal sense too: `Type` sits on the agent screen beside `Stop` and opens
the picker in one tap, so neither door costs more than the other.

The only screen that still asks "how do you want to enter this" is the new-agent composer
(`ui/NewAgentScreen.kt`), which has no conversation to anchor buttons to. Mic and keyboard,
nothing else.

Paseo's own daemon-side dictation (`dictation_stream_*`, see `packages/protocol/src/messages.ts`)
is deliberately **not** used in v1 — the phone-tethered transport makes streaming PCM from the
watch a poor trade against a free on-device recognizer.

## Transport

Phone-tethered: the watch never speaks the daemon protocol. It talks to the phone app over the
Wearable Data Layer, and the phone app owns the daemon connection, pairing, and E2EE. Consequence
to design around, not ignore: **the phone must be reachable**, and Data Layer wakeups have to
survive the phone app being backgrounded or killed.

## Settled

- **Agent detail needed the scrollable transcript, not a bigger tail.** Answered by building
  it: the summary card was the agent _title_, so no amount of extra lines would have turned it
  into a conversation. See "Agent detail" above.
- **`Stop` next to `Reply` was not safe at 52dp/52dp/10dp apart.** Stop is 38dp and muted, and
  now sits on a second row below Reply, offset sideways — separated on both axes rather than
  one. The asymmetry is the safety: two equal circles side by side invite a thumb to split the
  difference. Three abreast was never an option; 52 + 38 + 38 plus safe gaps is wider than the
  ~148dp a 450px round screen leaves inside its 22dp insets, and closing the gaps to fit would
  give back exactly what the sizes were bought with. `Type` shares the satellite row and is the
  nearer of the two to Reply on purpose — mis-tapping into a keyboard is recoverable, killing
  a run is not.
- **Canned replies are gone.** They were three chips on a screen the user had to pass through
  to speak, and the tap they saved was smaller than the tap they cost. Whether they should have
  been phone-configurable stopped being a question when the screen did.

## Open questions

1. "New agent from a voice prompt" is built (empty workspaces route straight to it). Keep it in
   v1, or cut it back to react-to-existing-agents only?
2. On the multi-agent workspace row, is `3 agents · 1 running` the right summary, or should it
   surface the most-urgent agent's actual status?
3. `truncated` currently just says "earlier history on your phone". Is crown-paging older
   entries worth the round trip on both sides, or is deferring to the phone the right answer
   for a wrist?
