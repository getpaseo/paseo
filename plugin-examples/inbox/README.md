# Kanban plugin (`inbox`)

A triage board for every agent session on a host. It answers one question: which agents are
waiting on me, and what do they need. Cards answer in place, so a permission prompt, an
AskUserQuestion, or a finished turn is dealt with without leaving the board.

This document is the design spec and the current state of the prototype. Sections marked
**Prototype** describe what is built; everything else is the target.

## Why a plugin

Paseo already computes everything the board shows. Each agent snapshot carries
`requiresAttention` and `attentionReason` (`permission`, `error`, `finished`), its pending
permission requests, its active turn, and its last error. Each workspace snapshot carries a status
bucket (`needs_input`, `failed`, `running`, `attention`, `done`) and a diff stat. The board is a
projection of that state, which is exactly what a client-only plugin surface is for. It needs no
server entry and no subprocess.

## Surfaces

- **Sidebar item "Kanban"** opening a global surface. The board lives here. The UI label is
  "Kanban"; the plugin id and directory stay `inbox`. Opening the board from a Command Center item
  routes through `openSurface`, and the host titles that screen with the surface id ("board")
  rather than the sidebar label.
- **Command Center items:** "Open Kanban" and "Next agent needing you". The second opens the board
  and the peek modal for the oldest card in the Needs you lane. The board reads the request from the
  plugin store, so the command needs no host change. There is no search bar on the board; the Command
  Center already searches agents and workspaces.
- **Workspace panel "Kanban"** hosting the same board filtered to the current workspace, so it can
  sit split beside an agent tab. Same component, one extra prop.

## Lanes

Three lanes, mapped from state rather than derived:

| Lane      | Membership                                                                               | Sort                                            |
| --------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Needs you | `requiresAttention` with reason `permission` or `error`, or a pending permission request | Oldest waiting first, from `attentionTimestamp` |
| Working   | `status` is `running` or `initializing`                                                  | Most recent `lastActivityAt` first              |
| Done      | `requiresAttention` with reason `finished`                                               | Newest first                                    |

Idle agents with no attention flag do not appear. They are reachable from the sidebar; the board is
for things that changed since you last looked.

Lanes are exclusive, decided in this order: a pending permission request (own or rolled up) or an
error puts the card in Needs you; otherwise a running or initializing agent is Working; otherwise a
`finished` attention flag is Done. Everything else is hidden.

The board shows root agents only. A same-workspace subagent contributes to its parent's card: the
parent shows a subagent count, and a subagent that needs you moves its parent into Needs you with
the subagent's request rendered under the parent's title. The parent link is the
`paseo.parent-agent-id` label on the raw agent snapshot, because the client API exposes the wire
payload rather than the derived plugin snapshot. This matches how the sidebar rolls up
descendant attention (see `docs/agent-lifecycle.md`, workspace status). A cross-workspace subagent
is its own card, as it already is its own workspace row.

Needs you sorts permission and question cards ahead of error cards at equal age. A blocked agent
burns wall clock; an errored one is already stopped.

## Cards

Every card carries: title (falling back to the workspace name), provider and model, project and
workspace name, time in the current state, the workspace diff stat when non-null, and a subagent
count when non-zero. Cards differ by lane and attention reason in what sits between the title and
the meta row.

**Question card** (pending permission with `kind: "question"`). The first question's text as the
body, its options as selectable rows with description as secondary text, a text field when the
question allows a free-text answer, and a Submit button. Multi-question requests show a "1 of 3"
stepper the way the timeline's question form does. Selecting an option on a single-select question
with one question submits immediately. The answer shape is the one `question-form-card-core.ts`
builds: `answers` keyed by question header, which the Claude provider remaps to full question text.
Bypass-mode agents never raise tool permissions, so for them this is the only Needs you card and it
is the one to get right.

**Permission card** (pending permission with `kind: "tool"`, `"plan"`, `"mode"`, or `"other"`).
The request title and description, then the request's `actions` when it carries any, else Deny and
Allow. Claude tool requests arrive without a title, so the card derives one from `request.detail`
the way the timeline's collapsed row does: "Write round2.txt" with the full path underneath, the
command for Bash, the query for search, the URL for fetch. Requests without `detail` fall back to
well-known `input` keys (`file_path`, `command`, `pattern`, `url`). Plan requests label Allow as "Implement", matching the timeline. Suggested permission-rule
updates are not offered from the card; that is a timeline decision, and the card links to the
agent for it.

**Error card.** The `lastError` message, one line, and Open agent. Nothing to answer.

**Working card.** The current tool call ("Bash: npm test", "Edit board.tsx: /src/board.tsx") and
the elapsed time. The daemon streams agent events only for agents the app has opened, and a plugin
cannot mark an agent as viewed, so the card polls the timeline tail every four seconds while it is
mounted instead of subscribing. Pressing opens the peek modal in read mode.

**Finished card.** First line of the last `assistant_message` from the timeline tail, a one-line
reply box, and Mark read.

Card presses open the peek modal. The question and permission controls are on the card itself
because they are the whole point; the modal is for reading context before answering.

## Peek modal

`Modal` from the host UI kit. Header: title, provider, status. Body: the last twenty timeline rows
in the canonical projection, rendered as plain text by row type (user message, assistant message,
tool call name plus one-line summary, reasoning collapsed to a "thinking" row). The pending request
renders at the bottom with the same controls as the card. Below that, a reply box that calls
`send()`. Footer: "Open agent" via `navigation.openAgent`.

This is a peek, not a chat. Paseo exposes no timeline renderer to plugins, and re-implementing the
transcript would lag the real one. The modal exists so you can answer with context and stay on the
board. Anything that needs the real transcript is one press away.

## Attention lifecycle

Answering a permission clears attention on the host. Sending a reply clears it through the existing
prompt-send path. Opening the agent clears it on focus. The only case that needs a plugin-driven
clear is a finished card you read in the peek and do not reply to; "Mark read" covers it by calling
the existing `clear_agent_attention` RPC. Archiving is never a dismissal.

## Data flow

Client entry subscribes once to `client.paseo.agents.subscribe` and `client.paseo.workspaces.subscribe`
and keeps a plain map of agent and workspace snapshots. The surface reads that map through a small
store hook. Initial load is `agents.list({ scope: "active", sort: [status_priority] })` and
`workspaces.list()`. Subagent rollup uses `parentAgentId`. Timeline tails for finished and working
cards are fetched lazily per card via `agents.ref(id).timeline.refetch({ direction: "tail", limit: 1 })`
and cached in react-query keyed by agent id and `updatedAt`.

## Layout

Desktop (`layout.compact` false): three equal lanes side by side, each scrolling independently,
lane header with count. Compact: one scroll view, lanes as collapsible sections, Needs you
expanded and the others collapsed with their count in the header. Lane order is fixed.

Colors come from `theme.colors` only. Needs you cards carry a left rule in `statusWarning` for
permission and question, `statusDanger` for error. Working uses `accent`. Done uses
`statusSuccess`. Text is `foreground` or `foregroundMuted`. No hardcoded colors.

## Keyboard triage

On web, the global surface (not the workspace panel, so shortcuts never double) binds unmodified
keys while it is mounted and the focus is not in a text field: `j`/`k` or the arrows move a focus
ring through the lanes in order, `Enter` opens the peek, `Escape` closes it, `1`–`9` answer a
single-question single-select card by option index (anything else opens the peek), and `y`/`n`
answer a permission card. After an answer the focus moves to the next card rather than following the
answered card into Done. The mapping is a pure function in `client/keyboard.ts` with tests.

Paseo's own shortcut handler runs in the capture phase on `window`, so app chords always win. The
only unmodified default chords are `Escape`, `Enter`, and `Space`, each scoped to its own context;
workspace jumps are Alt+digit on web. A plugin cannot shadow an app shortcut if one is ever added.
`Enter` while a card's title button has DOM focus both activates the button and opens the peek,
which land on the same card.

## Host additions

A `badge` source on `addSidebarItem` (`packages/plugin/src/contracts.ts`): `getSnapshot()` returns a
count or `null`, `subscribe(listener)` notifies on change. The sidebar row renders the count with
`<StatusBadge>` at its trailing edge and sums across hosts. The plugin passes the store's Needs you
count. Old clients ignore the field.

Two methods on the client `PaseoAgentHandle` in `packages/client/src/index.ts`:

```ts
respondToPermission(requestId: string, response: AgentPermissionResponse): Promise<void>;
clearAttention(): Promise<void>;
```

Both wrap RPCs the daemon has had for a long time (`agent_permission_response`,
`clear_agent_attention`), so there is no protocol change and no `server_info` feature.
`respondToPermission` uses the daemon client's wait variant, so answering a request that another
client already resolved rejects and surfaces as a toast instead of failing silently. The
compatibility gate is the method's presence on the handle: the plugin renders answer controls only
when `typeof handle.respondToPermission === "function"`, and otherwise shows Open agent in their
place. An old app bundle with a new plugin therefore degrades to the hand-off behavior.

**Prototype:** both methods are implemented in `packages/client/src/index.ts` with a unit test in
`index.test.ts`.

`PaseoApi` is re-exported to plugins by `@getpaseo/plugin`, so no plugin package change is needed.

## Out of scope

- Cross-host aggregation. A surface borrows one selected host and gets a host picker. One inbox
  across every host is the biggest possible win over Orca's board and it needs a host-side change
  to the plugin surface model, not a plugin.
- Notifications and sounds. The host already owns attention notifications.
- Permission-rule suggestions ("always allow"). Deferred to the timeline.

## Files

```
plugin-examples/inbox/
  paseo-plugin.json
  index.client.tsx        registration only
  client/
    store.ts              snapshot map, subscriptions, lane projection
    lanes.ts              pure lane and sort functions (unit tested)
    board.tsx             surface: lanes, compact sections
    card.tsx              card shell and meta row
    question-card.tsx     question controls
    permission-card.tsx   tool/plan/mode controls
    peek-modal.tsx        peek modal
    timeline-text.ts      canonical row to one-line text (unit tested)
```

Lane projection, question parsing, tool-call text, the keyboard resolver, and the store are pure
modules with tests (`npx vitest run plugin-examples/inbox/client`). Typecheck with
`npm run typecheck --workspace=@getpaseo/plugin`, whose `tsconfig.examples.json` covers every
example.

**Prototype verification (2026-09-04, web, dev daemon):** a Claude agent in bypass mode called
AskUserQuestion; the card rendered the three options, one press answered it, and the agent resumed
and landed in Done with its last line. The peek modal listed the prompt, the tool call, and the
reply; sending a reply from the modal ran another turn. Mark read removed the card. A default-mode
agent's Write request rendered "Write round2.txt" with its path, Deny and Allow; `y` on the focused
card allowed it and the file appeared. `j` then `2` answered a question card by index and focus
moved on. A two-minute Bash command showed as "Bash: python3 -c …" in Working. The sidebar badge
showed 2, then 1, then disappeared as cards were answered. "Next agent needing you" from the
Command Center opened the board with the peek for the oldest Needs you card. The compact layout
renders the three lanes as collapsible sections. Not covered: error cards, subagent rollup in the
UI, the workspace panel host, native platforms.
