# Daemon Request Hook

Daemon-facing UI frequently sends request/response pairs through the session websocket. Historically each component had bespoke refs to juggle request ids, dedupe rules, and timeouts. The `useDaemonRequest` hook consolidates that behavior so every async action exposes consistent `idle → loading → success/error` states plus retry and timeout semantics.

## Goals

- Provide React Query-style metadata (`status`, `isLoading`, `isError`, `data`, `error`, `requestId`, `updatedAt`) without adding another cache layer.
- Deduplicate in-flight requests by key so callers can `execute()` repeatedly without spamming the daemon.
- Surface configurable timeouts + retry policies to keep UI responsive when websocket responses stall.
- Offer a single, well-documented place to listen for daemon responses so components stop attaching ad-hoc `ws.on()` listeners.

## API Summary

```ts
const result = useDaemonRequest<Params, Data, ResponseMessage>({
  ws: session.ws,
  responseType: "checkout_status_response",
  buildRequest: ({ params, requestId }) => ({
    type: "session",
    message: {
      type: "checkout_status_request",
      cwd: params.cwd,
      requestId,
    },
  }),
  selectData: (message) => ({
    cwd: message.payload.cwd,
    currentBranch: message.payload.isGit ? message.payload.currentBranch : null,
  }),
  extractError: (message) =>
    message.payload.error ? new Error(message.payload.error.message) : null,
  getRequestKey: (params) => params?.cwd ?? "default",
  timeoutMs: 10_000,
  retryCount: 1,
});
```

The hook returns:

- `status`, `data`, `error`, `requestId`, `updatedAt`
- Boolean helpers (`isIdle`, `isLoading`, `isSuccess`, `isError`)
- `execute(params, overrides?)` – kicks off the request and resolves with parsed data
- `reset()` – clears the cached data/error back to `idle`
- `cancel(reason?)` – aborts the in-flight request and returns to `idle`

## Usage Pattern

1. Grab the websocket instance from `useDaemonSession` or `SessionContext`.
2. Call `useDaemonRequest` with the `responseType` you expect, a `buildRequest` factory, and a `selectData` parser. Always include indexes (agentId, cwd, etc.) in `getRequestKey` so dedupe stays deterministic.
3. Trigger requests via `execute` and feed the returned metadata into the UI (button states, skeletons, errors, etc.).
4. Use `extractError` when the daemon encodes errors in the payload so the hook can retry/timeout automatically.

### Example

```ts
const gitRepoInfo = useDaemonRequest<
  { cwd: string },
  { branch: string | null },
  CheckoutStatusResponseMessage
>({
  ws,
  responseType: "checkout_status_response",
  buildRequest: ({ params, requestId }) => ({
    type: "session",
    message: {
      type: "checkout_status_request",
      cwd: params?.cwd ?? ".",
      requestId,
    },
  }),
  getRequestKey: (params) => params?.cwd ?? "default",
  selectData: (message) => ({
    branch: message.payload.isGit ? message.payload.currentBranch ?? null : null,
  }),
  extractError: ({ payload }) => (payload.error ? new Error(payload.error.message) : null),
  retryCount: 1,
  timeoutMs: 8000,
});

useEffect(() => {
  if (agent?.cwd) {
    gitRepoInfo.execute({ cwd: agent.cwd });
  } else {
    gitRepoInfo.reset();
  }
}, [agent?.cwd, gitRepoInfo]);
```

### Request Overrides

`execute` accepts per-invocation overrides:

- `timeoutMs` / `retryCount` / `retryDelayMs`
- `dedupe` – set to `false` to bypass the default in-flight guard
- `requestKeyOverride` – supply a precomputed key when params cannot be serialized deterministically

### Matching Responses Without `requestId`

By default the hook matches responses via `payload.requestId`. For daemon events that omit it, pass a custom `matchResponse(message, ctx)` to scope responses (e.g., check `message.payload.agentId === ctx.params.agentId`).

### Cancellation & Cleanup

`cancel()` clears timers and resolves the pending promise with a rejection, which is handy when a component unmounts mid-flight. Always call `reset()` once a task completes if you need to drop stale data before the next daemon interaction.
