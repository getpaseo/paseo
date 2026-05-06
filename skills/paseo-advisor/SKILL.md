---
name: paseo-advisor
description: Spin up a single agent as an advisor — second opinion on the current task. Use when the user says "advisor", "second opinion", "what does X think", or wants an outside take without delegating the work itself.
user-invocable: true
argument-hint: "[--provider <name>] <question or topic>"
---

# Paseo Advisor

Single agent. Reads the situation you're in. Gives a judgment. You decide what to do — the advisor doesn't drive the work.

**User's request:** $ARGUMENTS

## Prerequisites

Read the **paseo** skill — provider for the advisor comes from orchestration preferences unless the user names one.

## Picking the advisor

1. **User named one** (`--provider claude/opus`) → use it.
2. **Otherwise** resolve from preferences — pick the category that matches the question:
   - Design / approach question → `planning`
   - "Did I miss something" review → `audit`
   - "Is this even right" → `research`
3. **Contrast helps.** If your own provider matches what preferences would pick, swap to a different family on purpose — fresh perspective is the point.

## The briefing

The advisor has zero context. Make it self-contained:

- The question, sharply.
- What you've considered and what you've ruled out.
- Relevant files by path (don't paste — let the agent read).
- Explicit ask: "give me a recommendation, with reasoning."

End with the no-edits suffix:

```
This is analysis only. Do NOT edit, create, or delete any files. Do NOT write code.
```

## Launch and synthesize

Create the advisor agent via Paseo with a `[Advisor] <topic>` title and the briefing as the initial prompt. Wait for it to finish. Read its response. Synthesize for the user — the advisor's verdict + your recommendation.

## Persistent advisor

If the user wants ongoing input ("keep this advisor for the next few decisions"), don't archive after the first reply. Send follow-ups when you need another take. Archive when the user says they're done, or when the topic shifts and a fresh context would serve better.
