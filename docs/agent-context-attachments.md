# Agent context attachments

An **agent context attachment** lets a user give a destination agent context from
another top-level Paseo agent on the same daemon. It is selected from the
New Agent attachment picker, the composer `+` menu, or the shared `@` menu.
`@` results deliberately group **Agents** separately from **Files & folders**;
choosing an agent removes the mention token and adds an attachment pill.

## Data flow

The client persists only reference/display metadata:

```ts
{
  kind: "agent_context",
  source: { serverId, agentId, title, workspaceLabel?, provider? }
}
```

The wire payload is intentionally smaller:

```ts
{ type: "agent_context", agentId, title? }
```

The client keeps `serverId` long enough to reject or clear a stale reference
when its draft moves to another host; it is never sent as a claim the daemon
must trust.

The destination daemon owns the reference, so it resolves the source just
before it creates an agent, builds a worktree/workspace context, or sends a
message. The wire never carries transcript text and draft checkpoints never
store it. A daemon resolves the reference to a normal `text` attachment with
`contextKind: "chat_history"` before prompt construction; no raw reference is
passed to providers or attachment renderers.

This is currently **same-host only**. A cross-host reference would require a
daemon-to-daemon transfer contract; it must not fall back to downloading a
transcript into the client merely to make the attachment work.

## Source eligibility and retention

The daemon accepts only a non-internal, non-archived, non-delegated source that
is not the destination agent itself. It reads retained timeline rows without
loading, resuming, or mutating a provider session. If the daemon no longer has
the source timeline retained, the attachment fails and asks the user to open
the source session on that host first.

## Privacy and limits

The daemon curates the source history. It includes user/assistant prose and a
small Paseo-owned set of tool-kind markers. It excludes reasoning, raw tool
input, provider tool names, tool summaries, and subagent logs.

Limits are enforced on the daemon, not trusted to the client:

- at most 5 unique source agents;
- at most 128 KiB of UTF-8 context per source;
- at most 384 KiB across one destination prompt; and
- at most 25,000 retained timeline rows scanned per source.

Contexts keep whole newest entries rather than splitting a message or marker.
The app also prevents selecting more than five references, but server-side
validation remains authoritative.

## Compatibility

This is gated by `server_info.features.agentContextAttachments`. Against an
older host, `@` does not offer agent results and the picker explains that the
host needs an update instead of allowing a selection. A persisted reference
sent to an older host fails with the upgrade message rather than being silently
dropped. The protocol schema remains additive and accepts the optional feature
flag for old peers.
