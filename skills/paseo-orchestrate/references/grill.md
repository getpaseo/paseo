# Grill

The grill phase extracts clarity from the user through structured questioning. It runs in default mode only — skipped in `--auto`.

## Protocol: Research First, Grill Second

Before asking the user anything:

1. Read the task description
2. Grep relevant files, types, functions
3. Read key files to understand the current state
4. Form your own understanding of the problem space

Then ask the user ONLY about things the code cannot answer: intent, scope boundaries, UX preferences, tradeoffs, priorities, acceptance criteria.

Never ask a question the codebase could answer. That wastes the user's time.

## Questioning Approach

Treat the task as a decision tree. Each design choice branches into sub-decisions, constraints, and consequences.

- Ask one question at a time
- Wait for the answer before moving on
- Drill depth-first into each branch until it's resolved or explicitly deferred
- For each question, state your recommended answer based on what you've learned from the code — the user can confirm or override
- Cycle through question types as appropriate:
  - **Feasibility** — can this actually work given the current architecture?
  - **Dependency** — what needs to happen first? What blocks what?
  - **Edge case** — what happens when X is empty, null, concurrent, offline?
  - **Alternative** — is there a simpler way to achieve this?
  - **Scope** — is this in or out? Where's the boundary?
  - **Ordering** — does the sequence matter? What's the critical path?
  - **Failure mode** — what happens when this breaks? How do we recover?

## Summaries

Every 3-4 questions, pause and summarize:

- **Resolved decisions** — what's been decided
- **Open branches** — what still needs discussion
- **Current focus** — what you're drilling into next

## Termination

Stop grilling when:

- All branches of the decision tree are resolved or explicitly deferred
- The user signals they're done ("go", "that's enough", "just build it")
- No meaningful questions remain

Conclude with a final summary of all resolved decisions and any deferred items. This summary feeds directly into the planning phase.
