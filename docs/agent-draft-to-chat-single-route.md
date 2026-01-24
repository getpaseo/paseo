# Agent draft → chat without “redirect” (single-route + typed state machine)

## Problem

Today, creating an agent feels like a screen change:

- The “New Agent” UI lives on `/agent`.
- On submit, we create the agent and then navigate to `/agent/:serverId/:agentId`.
- During creation, the UI previously looked like a redirect (different layout + loading copy).

Even though the layout is already “ChatGPT-like” (form + bottom input), the UX reads as a redirect.

## Goals (product)

1. **No redirect feel**: user stays on the “same” surface; only the content morphs.
2. **Linkable URL**: once created, URL becomes `/agent/:serverId/:agentId`.
3. **Optimistic user bubble**: immediately show the submitted prompt in the stream.
4. **Failure behavior**:
   - revert back to **draft** (form visible),
   - restore the prompt text (and attachments, if any) into the input,
   - do **not** keep optimistic bubbles around in draft (avoid confusing “half-created” history).
5. **Engineering guardrail**: avoid “ifs everywhere” by centralizing logic with a **typed state machine** and a **single view-model mapping**.

## Non-goals

- Persisting draft history across app restarts (optional later).
- Supporting “edit config after creation” on the same screen (config disappears after success).
- Reworking the backend agent creation API.

## Proposed routing (key to “set URL without changing screen”)

Use a **single Expo Router screen module** to serve both draft and agent chat variants.

Create an optional catch-all route (one module for both URLs):

- `packages/app/src/app/agent/[[...route]].tsx`

URL grammar (canonical):

- `/agent` → draft mode (agent creation UI)
- `/agent/:serverId/:agentId` → ready mode (real agent chat)

Because these URLs resolve to the **same file**, navigation from `/agent` → `/agent/:serverId/:agentId` changes the URL while keeping the same screen component module (no “route file” swap). This is the closest equivalent to “set the URL without changing the screen”.

Notes:
- Existing routes under `packages/app/src/app/agent/` that overlap (e.g. `[serverId]/[agentId].tsx`) should be consolidated into the catch-all route to avoid precedence ambiguity.
- If we still need legacy `/agent/[id].tsx` behavior, fold it into the same catch-all via `route.length === 1` handling (optional; separate decision).

## UI architecture: one shell, two bodies

Introduce a single “chat shell” that never changes its outer structure:

- Header area
- Main body area (stream *or* draft form)
- Bottom input area (always visible; wired differently by state)

Then render the shell from a single `view` object (see “View model mapping”), not from scattered conditionals.

## State machine (typed, impossible states)

### State shape

Use a reducer-based state machine (no library required) with a discriminated union:

```ts
type DraftModel = {
  serverId: string | null;
  config: {
    provider: string;
    modeId?: string;
    model?: string;
    cwd: string;
    // git/worktree options as needed
  };
  prompt: {
    text: string;
    images: Array<{ uri: string; mimeType: string }>;
  };
  errorMessage: string | null;
};

type CreateAttempt = {
  submittedAt: number;
  serverId: string;
  config: DraftModel["config"];
  prompt: DraftModel["prompt"];
};

type MachineState =
  | { tag: "draft"; draft: DraftModel }
  | { tag: "creating"; attempt: CreateAttempt; draftSnapshot: DraftModel }
  | { tag: "ready"; serverId: string; agentId: string };
```

Design intent:

- `creating` includes an `attempt` (what we optimistically render) and a `draftSnapshot` (what we can restore on failure).
- There is **no** `ready + draft` hybrid: once created, config is gone by construction.
- There is **no** `error` top-level state: failure transitions back to `draft` with `draft.errorMessage` set and prompt restored. This keeps rendering simple and matches the product requirement (“revert back into the draft”).

### Events

```ts
type MachineEvent =
  | { type: "ROUTE_DRAFT" }
  | { type: "ROUTE_READY"; serverId: string; agentId: string }
  | { type: "DRAFT_UPDATED"; draft: DraftModel }
  | { type: "SUBMIT_CREATE" }
  | { type: "CREATE_SUCCEEDED"; serverId: string; agentId: string }
  | { type: "CREATE_FAILED"; message: string };
```

### Transition table (exhaustive)

| Current | Event | Next | Notes |
|---|---|---|---|
| `draft` | `SUBMIT_CREATE` | `creating` | snapshot draft; build `attempt` |
| `creating` | `CREATE_SUCCEEDED` | `ready` | drive URL replace |
| `creating` | `CREATE_FAILED` | `draft` | restore prompt/images from snapshot; set error |
| `ready` | `ROUTE_DRAFT` | `draft` | only if user intentionally navigates back to `/agent` |
| any | `ROUTE_READY` | `ready` | enables deep-link open |

Implementation guardrail:

- Use an exhaustive `switch (state.tag)` / `switch (event.type)` with an `assertNever` helper so missing cases are compile-time errors.

## View model mapping (no if-statements everywhere)

The screen should not ask “am I creating?” in random places.

Instead, compute a single render model:

```ts
type ChatView =
  | {
      kind: "draft";
      headerTitle: "New Agent";
      showForm: true;
      formDisabled: false;
      streamItems: StreamItem[]; // empty
      input: { mode: "create"; isLoading: false; value: string };
      errorMessage: string | null;
    }
  | {
      kind: "creating";
      headerTitle: "New Agent";
      showForm: true;
      formDisabled: true;
      streamItems: StreamItem[]; // optimistic user msg + "Creating agent…"
      input: { mode: "create"; isLoading: true; value: string };
      errorMessage: null;
    }
  | {
      kind: "ready";
      headerTitle: "Agent";
      showForm: false;
      streamItems: StreamItem[]; // real session stream
      input: { mode: "chat"; agentId: string; serverId: string };
    };
```

Where `StreamItem` is the existing stream item union (`packages/app/src/types/stream`), or a parallel “local stream item” union if we don’t want to reuse store-driven `AgentStreamView` for draft/creating.

**Key rule:** the React tree renders from `ChatView` only. The state machine produces `ChatView` via `getChatView(state, selectors)`.

This prevents drift: any new UI element must be added to the view mapping, not bolted on behind new conditionals.

## Optimistic bubble strategy (matches required failure behavior)

On `SUBMIT_CREATE`:

1. Immediately transition to `creating` with an `attempt`.
2. In `creating`, render the same stream UI as a real agent:
   - a **user_message** stream item for the submitted prompt,
   - the **working indicator** (same as when an agent is running).
3. Blur/dismiss the input so the stream is revealed (no keyboard covering the screen).

On failure (`CREATE_FAILED`):

- Transition back to `draft` and render **no** optimistic stream items (empty stream).
- Restore the input value from `draftSnapshot.prompt.text` (and images).
- Show the error in the draft UI (same as today’s `errorMessage` behavior in `packages/app/src/app/index.tsx`).

This satisfies:
- “optimistic bubble” while creating,
- no half-created history on failure,
- “don’t lose the prompt”.

## Where side effects live (keep reducer pure)

Reducer remains pure; side effects (createAgent, URL replace) happen in an effect layer:

- `useAgentDraftToChatMachine()`
  - parses route segments → dispatches `ROUTE_*` events
  - watches for `state.tag === "creating"` and performs `createAgent(attempt)`
  - on success: dispatch `CREATE_SUCCEEDED` then `router.replace("/agent/:serverId/:agentId")`
  - on failure: dispatch `CREATE_FAILED`

Important: the `router.replace` should happen as a consequence of state change (success), not inline inside UI handlers, so we don’t leak navigation logic across components.

## Implementation outline (incremental)

1. **Add single route file**
   - Create `packages/app/src/app/agent/[[...route]].tsx`.
   - Temporarily embed existing “New Agent” UI + existing “AgentScreen” UI inside it (no behavior change yet).
2. **Extract shell**
   - Introduce a shared `AgentChatShell` component that can render header/body/footer in a stable layout.
3. **Introduce reducer machine + view mapping**
   - Add `useAgentDraftToChatMachine` + `getChatView`.
   - Replace scattered booleans with `ChatView`.
4. **Wire optimistic creating view**
   - Add local “draft/creating stream surface” (simple FlatList of message components), or generalize `AgentStreamView` to accept local items.
5. **Replace `/` behavior (optional)**
   - Make `/` redirect to `/agent` (or leave `/` as-is and treat it as an alias).

## Open questions / decisions

1. Should `/` remain the “new agent” entry, or should `/` become an agent list and `/agent` become the sole entry?
2. Do we want to preserve any of the draft form values when navigating away and back to `/agent` (session-only), or always reset?
3. If attachments are supported on draft creation, do we want optimistic rendering of images in the creating stream (recommended: yes, from `attempt.prompt.images`)?
