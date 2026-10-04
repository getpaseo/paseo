# Brain switching: moving a conversation to another provider

Switching an agent from OpenCode to Claude or Codex keeps the Paseo agent id,
workspace, worktree, labels, timestamps, and timeline. Only the provider session
is replaced.

`AgentManager.setAgentProvider(agentId, provider, modelId)` closes the current
runtime, starts a fresh session on the target provider, and re-registers it under
the same agent id. It reaches the client as `set_agent_provider_request` through
`AgentConfigSession`, and the model picker raises it when the user picks a model
that belongs to a different provider.

## Why the new runtime is created, not resumed

A persisted provider session belongs to the provider that minted it. `persistence`
(`{ provider, sessionId }`) is what `ensureAgentLoaded()` reads to decide how to
bring a closed agent back: with a handle it calls `resumeAgentFromPersistence`
against `handle.provider`, without one it creates a session from the stored
config. `reloadAgentSession` resolves its provider the same way.

So the handle, not `runtimeInfo`, is what pins an agent to its provider.
`runtimeInfo` is a live-state mirror that no load path reads. Carrying the old
handle across a switch leaves the record pointing at the previous provider's
session, and the next resume attaches to it —
`agent-manager.test.ts` holds that case ("drops the previous provider session
handle from the stored record").

Nothing clears the handle explicitly. `registerSession` re-derives `persistence`
and `runtimeInfo` from the session it installs, and the agent snapshot is
projected whole, so installing the new session is what retires the old handle.

## Why not createAgent

`createAgent` begins with `deleteAgentState`, which drops the durable timeline.
That is correct for a new agent and fatal for a switch, whose entire point is that
the transcript survives. `setAgentProvider` therefore mirrors
`reloadAgentSessionInternal` — close, build, `registerSession` with the preserved
labels, workspace, owner, and timestamps — and differs from it only in calling
`createSession` on a different provider's client instead of `resumeSession`.

## Conversation context

`config.model` moves to the requested model of the new provider. `modeId`,
`thinkingOptionId`, `featureValues`, and `providerOptions` are dropped: each names
something only the previous provider offers.

The native provider history does not move either. An OpenCode session is not a
Claude session. The Paseo timeline remains and carries a `Switched provider: X → Y`
marker at the cut. A compact handoff note carries the available conversation
context into the new provider's first turn. The agent record stores that note,
so a daemon restart or a rejected first turn does not discard it. The note is
consumed after the provider accepts the turn. The Second Brain supplies durable
project context separately.

## Missing native sessions

An interactive resume or reload can encounter a deleted Codex rollout. In that
case a replacement provider session keeps the same Paseo agent identity,
metadata, and available timeline. A saved handoff takes precedence over a note
rebuilt from the available conversation context. Cold recovery can only use
context that was persisted; it cannot reconstruct a deleted native transcript.

This recovery requires the specific missing-rollout error. Authentication,
transport, and archived-history failures retain their original error and handle.
A replacement that fails to initialize also leaves the stored record intact.

## Failed switches

A failed switch leaves the agent `closed` on its old provider, as reload does. The
record still resumes its original session, so nothing is lost by declining and the
switch can be retried.
