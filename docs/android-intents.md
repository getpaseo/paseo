# Android intents

What the Android app accepts from other apps, what it exposes for automation,
and the rules every entry point follows. The pieces live in
`packages/app/src/intents/`, the native module
`packages/app/modules/paseo-android-intents/`, the shortcut config plugin
`packages/app/plugins/with-android-shortcuts.js`, and the `intentFilters` block
in `packages/app/app.config.js`.

## Entry points

| Entry point                                | Android intent                                        | What happens                                                                              |
| ------------------------------------------ | ----------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Share sheet: text, URL, one or more images | `SEND` / `SEND_MULTIPLE` with `text/plain`, `image/*` | Lands in the New workspace composer as a draft. The user picks the project and sends.     |
| Text selection menu ("Paseo")              | `PROCESS_TEXT` with `text/plain`                      | Same as a text share. Paseo never writes the selection back.                              |
| `paseo://` links                           | `VIEW` with the `paseo` scheme                        | Routes below. Also used by launcher shortcuts.                                            |
| Static launcher shortcuts                  | long-press the app icon                               | New workspace, Open project, History. Declared by the config plugin.                      |
| Dynamic launcher shortcut                  | long-press the app icon                               | "Resume <workspace>" for the last workspace the user opened. Set from the app at runtime. |
| Assistant catalog provider                 | query `content://sh.paseo.assistant/…`                | Read-only workspace, agent, and message listing for on-device assistants. See below.      |
| Pairing offer                              | any URL with `#offer=`                                | Adds the host. See `OfferLinkListener` in `packages/app/src/app/_layout.tsx`.             |

Shares and selections always go to the New workspace composer. It is the one
surface that exists before a host or workspace is chosen, and a fresh share
appends to whatever draft is already there rather than replacing it. Only text
and images are accepted; other files need a host to upload to, and there is
none yet at share time. The user sees a toast naming how many files were
skipped.

## Links

`paseo://<path>` resolves to the app route `/<path>`, so every route in
`packages/app/src/app` is reachable. These are the ones meant for other apps.
Every query parameter is optional unless marked.

| Link                                                                                                              | Parameters                                                      | Result                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `paseo://new`                                                                                                     | `prompt`, `serverId`, `projectId`, `dir`, `name`, `draftId`     | New workspace screen. `prompt` is appended to the composer draft; nothing is sent.                           |
| `paseo://agent`                                                                                                   | `agentId` (required), `serverId`, `prompt`, `send`              | Opens the agent. `prompt` is appended to its composer. `send=true` sends it instead, if the setting allows.  |
| `paseo://workspace`                                                                                               | `workspaceId` (required), `serverId`, `agentId` or `terminalId` | Opens the workspace, on the named agent or terminal tab when given.                                          |
| `paseo://h/<serverId>/agent/<agentId>`                                                                            | `prompt`, `send`                                                | Canonical agent link (`buildAgentDeepLink` in `packages/protocol`). Same prompt handling as `paseo://agent`. |
| `paseo://h/<serverId>/workspace/<workspaceId>`                                                                    | `open=agent:<id>` / `terminal:<id>` / `file:<encoded>`          | Canonical workspace link.                                                                                    |
| `paseo://open-project`, `paseo://sessions`, `paseo://schedules`, `paseo://settings`, `paseo://settings/<section>` | none                                                            | Open that screen.                                                                                            |

`paseo://agent` and `paseo://workspace` exist because some callers can only
fill query parameters, never path segments. They resolve the host and replace
themselves with the canonical route.

**Host resolution** when `serverId` is omitted: the host of the last opened
workspace, else the only configured host. With several hosts and no history
the link fails with a toast asking for `serverId`. An unknown `serverId` fails
the same way; a link never adds or picks a host on its own.

**Prompts** are capped at 16,000 characters and merged into the target draft,
which survives until that composer mounts. Sending without a tap is off by
default: `send=true` only sends when **Settings → General → Send prompts from
links** is on, because any installed app can open a `paseo://` link and an
agent runs commands on the host. With the setting off, or the host offline, the
prompt lands in the composer and a toast says why it was not sent. `send` is
ignored on `paseo://new`; creating an agent goes through the New workspace
form.

## Rules

- Payloads from the native side are validated with a schema before use and
  dropped whole when malformed. Route parameters are read through
  `readLinkParam` and friends in `packages/app/src/intents/automation-link.ts`,
  never straight from `useLocalSearchParams`.
- Shared files are accepted only as `content://` URIs with an `image/*` type,
  copied into the app cache (16 files, 25 MB each at most), and handed to the
  attachment store as `file://` paths. The original grant is never retained.
- Links never launch components, open arbitrary URLs, or change hosts. The only
  side effect a link can have without a tap is the opt-in prompt send above.
- Dynamic shortcut links are checked on the native side to use the `paseo`
  scheme and are pinned to the app's own package.
- One share is one prompt: the native module strips the delivered intent after
  reading it so activity recreation and React Native reloads do not replay it.

## Assistant catalog provider

Links let another app act, but not look. The app exports a read-only content
provider (`AssistantContentProvider` in the native module) with three tables:

| URI                                                                  | Columns                                                                                 |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `content://sh.paseo.assistant/workspaces?q=&limit=`                  | `id`, `serverId`, `name`, `project`, `branch`, `status`, `agentCount`, `lastActivityAt` |
| `content://sh.paseo.assistant/agents?workspaceId=&q=&limit=`         | `id`, `serverId`, `workspaceId`, `name`, `provider`, `status`, `lastActivityAt`         |
| `content://sh.paseo.assistant/messages?agentId=&workspaceId=&limit=` | `id`, `serverId`, `workspaceId`, `agentId`, `agentName`, `kind`, `createdAt`, `text`    |

`workspaces` and `agents` come from a catalog the app publishes whenever hosts,
workspaces, or agents change: ids, names, status, and activity, most recent
first, capped at 100 workspaces and 200 agents. Paths, prompts, and transcripts
are never in it. Those two tables read a file, so they work without starting
React Native and answer as of the last time the app was open. `q` is a
case-insensitive substring match over the row's columns and `limit` is 1 to 100
(default 25).

On every table a SQL selection or sort order is refused rather than ignored, and
only callers in the `com.colonelpanic.eva` package family are served.

### Messages

`messages` is the transcript, so it cannot come from a file. Pass exactly one of
`agentId` or `workspaceId` — `agentId` wins when both are set, neither is an
error — and `limit` 1 to 50 (default 10). Rows are newest first, `kind` is
`user`, `assistant`, `tool`, or `notice`, and `text` is plain text clipped to
1000 characters. A `workspaceId` fans out over that workspace's non-archived
top-level agents on every host that owns it and merges them by time.

This table needs the app process alive. The provider's binder thread posts an
`onAssistantQuery` event through `AssistantQueryBridge` and parks for about
seven seconds; `AndroidAssistantQueryListener` fetches the timelines from the
daemon and answers with `resolveAssistantQuery`. Reasoning, todos, and tool
internals are dropped on the way, because an assistant reads these out loud.

Anything that keeps the app from answering — Paseo not running, a host offline,
an unknown id, a timeout, a failed fetch — comes back as one `kind=notice` row
whose `text` is a sentence the assistant can read, not an exception. Only a
request the provider cannot parse throws. A workspace whose agents have said
nothing yet returns no rows.

The authority is `sh.paseo.assistant` for release builds and
`<package>.assistant` for the debug variant, declared by
`packages/app/plugins/with-assistant-provider.js`, because Android refuses to
install two apps that claim one authority. Picking a target is the
assistant's job: it queries, chooses, then opens a `paseo://agent` or
`paseo://workspace` link with the id.

## Invoking from adb

```bash
adb shell am start -a android.intent.action.VIEW -d 'paseo://new?prompt=Fix%20the%20flaky%20test'
adb shell am start -a android.intent.action.VIEW -d 'paseo://agent?agentId=agent-123&prompt=Run%20the%20tests&send=true'
adb shell am start -a android.intent.action.SEND -t text/plain --es android.intent.extra.TEXT 'https://github.com/getpaseo/paseo/issues/1' sh.paseo
adb shell am start -a android.intent.action.PROCESS_TEXT -t text/plain --es android.intent.extra.PROCESS_TEXT 'explain this' sh.paseo
```

Use the variant's package id (`sh.paseo`, `sh.paseo.debug`) where a package is
named; the activity is always `<package>.MainActivity`.

## Automation clients

An automation tool that can only launch a fixed action, a fixed URI base, and
scalar query values (a voice assistant's declarative intent binding, a Tasker
task, a widget) has everything it needs in the links table: action `VIEW`,
base `paseo://agent` or `paseo://new`, query slots for the parameters.
Launching a link proves the handoff, not that the prompt was sent; a client
that needs the outcome has to observe the agent through the daemon. Ids come
from the catalog provider above or from the user.

## Adding an entry point

1. Declare the filter in `androidIntentFilters` in `app.config.js`, or the
   shortcut in `STATIC_SHORTCUTS` in the config plugin.
2. Parse and bound the input in `packages/app/src/intents/`; add the test
   beside it.
3. Stage prompts through `stagePendingPrompt` keyed by the draft the composer
   will own. Do not write to the draft store directly: the composer merges the
   pending prompt once it has hydrated, which is what makes cold start, warm
   start, and an already-open composer behave the same.
4. Document the link or filter in the tables above.
