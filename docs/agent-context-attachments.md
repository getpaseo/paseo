# Agent context attachments

An **agent context attachment** gives a destination agent context from another
top-level Paseo agent. The source can belong to the destination daemon or any
connected Paseo host. Select it from the New Agent attachment picker, the
composer `+` menu, or the shared `@` menu. `@` remains a same-host shortcut;
use **Attach agents** to choose a cross-host source.

## Transfer contract

The app negotiates one mode when you attach the source. It stores that choice
with reference/display metadata, never a transcript:

```ts
{
  kind: "agent_context",
  source: { serverId, agentId, title, workspaceLabel?, provider? },
  crossHost?:
    | { destinationServerId, mode: "secure" }
    | { destinationServerId, mode: "compatibility", userConfirmed: true }
}
```

The modes form an explicit compatibility ladder:

1. **Local reference.** On the same daemon, the wire value is
   `{ type: "agent_context", agentId, title? }`. The destination resolves its
   retained timeline at submission time.
2. **Secure transfer.** When both daemons advertise `agentContextTransfer`, the
   destination supplies its stable daemon public key. The source daemon curates
   the timeline, seals it to that key, and returns a destination-bound capsule.
   The app relays ciphertext and cannot read the transcript.
3. **Compatibility transfer.** If secure transfer is unavailable but the source
   advertises `agentForkContext`, the picker labels the downgrade and requires
   confirmation. At send time the source daemon curates context through
   `agent.fork_context`; the app relays the returned readable text in memory as
   a normal `chat_history` attachment.

Compatibility mode never runs automatically. A secure selection that can no
longer negotiate fails and asks you to attach it again. A source daemon without
either secure transfer or `agentForkContext` is unavailable. This avoids raw
timeline scraping and keeps redaction/curation owned by the source daemon.

The app stores neither compatibility plaintext nor secure submit-time
ciphertext in drafts or queued messages. Both are created for the active send.
Provider-owned history or echoed user-message events can retain resolved context
after submission, as they do for any prompt attachment.

Workspace and branch auto-naming are a separate model boundary. Agent context
references and resolved chat-history text are excluded from naming seeds.

## Resolution timing

A reference is live metadata until submission. History added after selection
can be included. A same-host retry resolves the then-retained source timeline.
A cross-host send captures one source-curated snapshot for that operation and
the destination decrypts or receives that snapshot without consulting its own
filesystem.

Moving a draft to another destination invalidates its destination-bound
cross-host selections. Archiving a source, losing its retained timeline, or
disconnecting either required host makes the operation fail rather than omit
context.

## Source eligibility and retention

Local and secure transfer accept only a non-internal, non-archived,
non-delegated source that is not the same-host destination agent. They read
retained timeline rows without loading, resuming, or mutating a provider
session. If retained history is unavailable, the operation asks you to open the
source session on that host first.

Compatibility transfer inherits the older `agent.fork_context` behavior. The
source may load a closed but resumable agent to build that export. This is part
of the labeled compatibility downgrade, not behavior of secure transfer.

## Privacy and limits

Local and secure transfer use the portable agent-context curator. It includes
user/assistant prose and a small Paseo-owned set of tool-kind markers. It
excludes reasoning, raw tool input, provider tool names, tool summaries, and
subagent logs. Compatibility transfer uses the source daemon's legacy Fork
curator, which can include daemon-generated tool summaries but still excludes
reasoning and raw external tool input. Cross-host transfer does not serialize
live or stored agent status snapshots; their sensitive-metadata redaction
remains at the status projection boundary.

Secure capsules use the daemons' Curve25519 identities and authenticated
encryption. The capsule binds the destination server id and source agent id;
another daemon cannot open it, and modified or relabeled ciphertext is rejected
before prompt construction.

Selection and daemon limits are explicit:

- at most 5 selected source agents in the app and 5 unique local/secure sources
  at the destination;
- at most 128 KiB of UTF-8 context per same-host source;
- at most 384 KiB across resolved agent-context attachments in one prompt;
- at most one fifth of that aggregate budget per secure capsule, so five
  independently exported capsules cannot exceed the destination budget; and
- at most 25,000 retained timeline rows scanned per source.

Contexts keep whole newest entries rather than splitting a message or marker.
Legacy compatibility exports do not gain the newer portable byte bounds; this
is another reason the picker prefers secure transfer.

## Protocol compatibility

The wire schema adds an optional encrypted `transfer` field and the optional
`server_info.features.agentContextTransfer` flag. The secure RPCs use
`agent.context.*.request` / `.response` names. Old clients continue sending
local references to new daemons, and old daemons ignore the optional feature
flag shape they do not advertise.

Feature behavior is gated once per source/destination pair. New daemons use
secure transfer. Older daemons degrade only through the confirmed compatibility
mode above. They do not receive unknown transfer RPCs, and unsupported sources
remain disabled in the picker.
