# ACP stuck active turn — diagnosis and fix plan

## Observed production failure (agent fa2e87ed, provider minimax-code)

Every `continue` after the first one failed instantly with:

```
Internal error: MiniMax Code Runtime failed: Session already has an active Turn.
Use queue send to deliver the message after it. | code=-32603
```

## Verified causal chain

1. MiniMax ran turn `81ad800a` from 14:24:21 to 15:53:18, then went quiet without
   ever responding to its `session/prompt` request. Its own runtime log has no
   terminal record for that turn.
2. At 15:55:59 the user's next message reached Paseo. Paseo opened a NEW turn id
   (`2bc6cdd3`) and called `session/prompt`. MiniMax rejected it: the old turn was
   still open on its side.
3. Paseo's ACP adapter turned that rejection into `turn_failed`, the manager set
   `lifecycle = "error"` and cleared its own turn tracking. The daemon now believed
   the session was idle while MiniMax still held the turn. Every retry recreated the
   same split-brain (`f571d82f`, `3315f73d`, `313ae78a`).
4. At 16:02 the session was reloaded from persistence. MiniMax accepted turn
   `d71cee11` at 16:03:07 and kept working. So reloading the provider session is the
   operation that actually clears the stuck state — not retrying the prompt.

There is no trace of a force-cancel or interrupt timeout in the daemon log for this
agent, and the cancel path is not what failed: the daemon sent no cancel for this
agent in the whole window. The defect is purely that a provider-side stuck turn is
treated as a permanent terminal error instead of a recoverable desync.

## Secondary defect (same symptom family)

`ACPAgentSession.interrupt()` resolves as soon as `connection.cancel()` resolves.
Per the ACP spec, cancel is only a notification: the agent must still answer the
original `session/prompt` with `stopReason: "cancelled"`. Paseo clears
`activeForegroundTurnId` immediately, so a prompt sent right after a cancel can race
the provider's own release of the turn. Same `-32603`, same split-brain.

## Fix design

Two independent, separately tested changes.

### A. Recover a provider-side stuck turn instead of terminal-failing the agent

New `ProviderStuckTurnError` in `packages/server/src/server/agent/` (agent layer must
not import from providers/, but providers/ already imports agent/ types — verify
direction before choosing placement; otherwise detect structurally in agent-prompt.ts).

The ACP adapter throws it when `session/prompt` is rejected with the provider's
"already has an active turn" answer. The existing recovery branch in `startAgentRun`
reloads the session from persistence and retries the prompt once, exactly like the
existing `StaleProviderSessionError` path.

Guard: retry at most once per prompt dispatch, so a provider that never releases its
turn surfaces the original error rather than looping.

### B. Wait for the provider's cancel acknowledgment

In `ACPAgentSession`, remember the in-flight prompt promise. `interrupt()` awaits the
provider's terminal response to that prompt (bounded by a timeout) before resolving,
so the session does not claim idleness while the provider still owns the turn.

## Verification plan

- Unit tests first, watched failing, then implementation.
- ACP adapter test: prompt rejected with the active-turn answer, assert the session
  surfaces a recoverable stuck-turn signal, not a silent terminal error.
- AgentManager/prompt test: real manager + fake session, assert reload-and-retry and
  no infinite retry.
- Cancel test: interrupt does not resolve until the prompt settles.
- Regression: run the touched suites plus typecheck/lint. No protocol changes.
- Live verification against the real `mcode` binary (present at
  /Users/huazhongmin/.nvm/versions/node/v22.22.0/bin/mcode, v0.7.1) if feasible.
