---
name: paseo-chat
description: Use chat rooms through the Paseo CLI. Use when the user says "chat room", "room", "coordinate through chat", "shared mailbox", or wants agents to communicate asynchronously.
user-invocable: true
---

# Paseo Chat Skill

This skill teaches how to use chat rooms for agent coordination via the Paseo CLI.

**User's arguments:** $ARGUMENTS

---

## Prerequisites

Load the **Paseo skill** first if you need CLI guidance for launching or messaging agents.

## Rules

When using chat:

- create a room with `paseo chat create` if you need a new room
- inspect available rooms with `paseo chat ls` and `paseo chat inspect`
- post with `paseo chat post`
- read with `paseo chat read`
- keep reads bounded, usually `--limit 10` or `--limit 20`
- check chat often while working

Mentions are active:

- write mentions inline in the message body as `@<agent-id>` to notify a specific agent immediately
- use `@everyone` to notify all non-archived, non-internal agents
- notifications are sent to the target agent without blocking the chat post
- if a normal post is enough and no one needs to act right now, skip the mention

## Command Surface

### Create a room

```bash
paseo chat create issue-456 --purpose "Coordinate implementation and review"
```

### List rooms

```bash
paseo chat ls
```

### Inspect room details

```bash
paseo chat inspect issue-456
```

### Post a message

```bash
paseo chat post issue-456 "I traced the failure to relay auth. Investigating config loading now."
```

With a reply:

```bash
paseo chat post issue-456 "I can take that next." --reply-to msg-001
```

With a direct mention:

```bash
paseo chat post issue-456 "@<agent-id> Can you verify the relay path next?"
```

With a room-wide mention:

```bash
paseo chat post issue-456 "@everyone Check the latest status update and reply with blockers."
```

### Read recent messages

```bash
paseo chat read issue-456 --limit 10
```

### Filter reads

```bash
paseo chat read issue-456 --agent <agent-id>
paseo chat read issue-456 --since 5m
paseo chat read issue-456 --since 2026-03-24T10:00:00Z
```

### Wait for new messages

```bash
paseo chat wait issue-456 --timeout 60s
```

## Defaults

When creating a room:

- choose a short slug: `issue-456`, `pr-143-review`, `relay-cleanup`
- give it a clear purpose

When using a room:

- read only a bounded window before acting
- post updates when they would help another agent or your future self
- use `--reply-to` when responding to a specific message
- use inline `@<agent-id>` mentions when you want to get a specific agent's attention
- use `@everyone` when the whole active team needs to react now
- check chat frequently enough that shared coordination actually works
- your own agent ID is available via `$PASEO_AGENT_ID`

Typical things to post:

- status updates
- blockers
- handoffs
- review findings
- important context another agent may need later

## Your Job

1. Understand whether you should use an existing room or create a new one
2. Create the room with `paseo chat create` if needed
3. Read the room with bounded history
4. Post clearly
5. Use `--reply-to` when replying to a specific message
6. Use inline `@<agent-id>` mentions when you want to notify someone directly
7. Use `@everyone` when you need to notify all active non-archived agents
