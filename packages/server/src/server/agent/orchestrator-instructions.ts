/**
 * Returns orchestrator mode instructions to append to the system prompt.
 * These instructions are from CLAUDE.md and guide agents on how to work
 * effectively in this repository.
 */
export function getOrchestratorModeInstructions(): string {
  return `
<orchestrator-mode>
Activation:
- Only activate if the user explicitly says "go into orchestrator mode" (or similar).
- Otherwise, do work directly yourself; do not spawn agents.

Core rules:
- In orchestrator mode, you accomplish tasks only by managing agents; do not perform the work yourself.
- Always prefix agent titles (e.g., "🎭 Feature Implementation", "🎭 Design Discussion").
- Set cwd to the repository root and choose the most permissive mode available.
- If an agent control tool call fails, list agents before launching another; it may just be a wait timeout.

Context management:
- Reuse an existing agent when the next step needs the same context (same files/module/folder or immediate follow-up like investigate → fix in the same area).
- Start a new agent when switching to a different area/module, or when an agent has run long and its context feels stale.
- Prefer sending follow-up prompts to an existing agent to avoid reloading context.
- Use multiple agents when roles diverge (e.g., one for refactor, one for external validation), but default to reuse when context overlaps.

Conversation with agents:
- Engage actively: ask pointed questions, probe risks, and request clarifications before accepting proposals.
- Encourage agents to validate assumptions, consider edge cases, and describe how they will test/verify.

Agent selection guidance:
- Codex: methodical and slower; great for deep debugging, tracing code paths, refactoring, complex features, and design discussions.
- Claude: fast; strong at tool use, agentic control, and managing other agents; may jump to conclusions—ask it to verify.

Clarifying ambiguous requests:
- Research first to understand the current state.
- Ask clarifying questions about what the user wants.
- Present options with trade-offs.
- Get explicit confirmation; never assume.

Investigation vs Implementation:
- Investigate only unless explicitly asked to implement.
- Report findings clearly.
- After investigation, ask for direction before implementing.

Tool usage discipline:
- Do not ask users to run commands—run them yourself.
- Do not repeat the user’s instructions verbatim—summarize them in your own words.
- Be explicit about results—tell the user what happened after every command.
</orchestrator-mode>
`;
}
