---
name: paseo-advisor
description: Spin up a single agent as an advisor — second opinion on the current task. Use when the user says "advisor", "second opinion", "what does X think", or wants an outside take without delegating the work itself.
user-invocable: true
argument-hint: "[--profile <name>] <question or topic>"
---

# Paseo Advisor

Single agent. Reads the situation you're in. Gives a judgment. You decide what to do — the advisor doesn't drive the work.

Use the user's request and current conversation as input, including any arguments supplied with the skill invocation. Optional syntax: `[--profile <name>] <question or topic>`.

## Prerequisites

Read the **paseo** skill. Call `list_profiles` before choosing the advisor. Do not create the advisor until you have read the configured profiles and their `notes`.

## Picking the advisor

1. **User named a profile** (`--profile UI Work`) → select it by name.
2. **Otherwise** choose the profile whose `notes` best fit the question. Match the actual work: design and approach, audit and review, or research and root-cause analysis.
3. **Contrast helps.** When several profiles fit, prefer a different provider family from your own so the second opinion is genuinely fresh.

Materialize the selected profile into `create_agent` as described by the **paseo** skill. If no profile fits, use Paseo's provider discovery fallback.

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

## Forwarded skills

If the user's request contains another skill reference, such as `/unslop`, `/skill:unslop`, or `$unslop`, the user is asking the advisor to run that skill against the current task. Examples:

- `/paseo-advisor /unslop` → advisor runs `/unslop` on the current diff.
- `/paseo-advisor /unslop-risk` → advisor does an unslop-risk review.
- `/paseo-advisor $diagnose this build failure` → advisor invokes `/diagnose`.
- `/skill:paseo-advisor /skill:unslop` → advisor runs the `unslop` skill on the current diff in Pi.
- `$paseo-advisor $unslop` → advisor runs the `unslop` skill on the current diff in Codex.

Parse the forwarded skill name from the user's request (`/<name>`, `/skill:<name>`, or `$<name>`), excluding this skill's own invocation. In the briefing, tell the advisor explicitly:

```
Invoke the `<name>` skill against this task. Load it via the Skill tool before doing anything else.
```

Pass through any remaining arguments after the skill name as the skill's own input. The advisor — not you — runs the skill; you're still just the orchestrator handing it the work.

## Launch and synthesize

Create the advisor agent via Paseo with a `[Advisor] <topic>` title and the briefing as the initial prompt. Wait for it to finish. Read its response. Synthesize for the user — the advisor's verdict + your recommendation.

## Persistent advisor

If the user wants ongoing input ("keep this advisor for the next few decisions"), don't archive after the first reply. Send follow-ups when you need another take. Archive when the user says they're done, or when the topic shifts and a fresh context would serve better.
