import type { HubcodeCommand } from "./types.js";

/**
 * Curated slash-commands Hubcode ships by default. Chosen to cover the
 * everyday software-engineering loop: plan → implement → test → review →
 * ship. Users can disable individual commands but not delete them.
 *
 * Each command is `scope: "global"` so it installs into every activated
 * agent's home config. Authors pointing at specific workspaces/projects
 * should be created from the Settings UI.
 */
export function buildBuiltinCommands(): HubcodeCommand[] {
  const cmds: Array<Omit<HubcodeCommand, "id" | "author" | "scope"> & { id: string }> = [
    {
      id: "hubcode.plan",
      name: "plan",
      displayName: "Plan",
      description: "Draft a step-by-step implementation plan before touching code.",
      prompt:
        "You are about to implement a change. First, produce a concise plan:\n\n" +
        "1. Restate the goal in one sentence.\n" +
        "2. List the files or modules you expect to touch.\n" +
        "3. Sketch the key data structures or types involved.\n" +
        "4. Identify edge cases, risks, and unknowns.\n" +
        "5. Propose the order of changes.\n\n" +
        "Do NOT write code yet — wait for approval of the plan.",
      tags: ["planning", "design"],
    },
    {
      id: "hubcode.review",
      name: "review",
      displayName: "Code review",
      description: "Review the current diff like a staff engineer.",
      prompt:
        "Perform a rigorous code review of the pending changes.\n\n" +
        "Check: correctness, edge cases, naming, duplication, tests, security, " +
        "performance hot paths, and API/schema backward compatibility. " +
        "Quote the specific file:line for each issue. Separate blockers from nits.",
      tags: ["review", "quality"],
    },
    {
      id: "hubcode.tdd",
      name: "tdd",
      displayName: "TDD cycle",
      description: "Drive a test-first red/green/refactor loop.",
      prompt:
        "Apply the TDD discipline:\n\n" +
        "1. Write the smallest failing test that captures the next requirement.\n" +
        "2. Run tests — confirm it fails for the right reason.\n" +
        "3. Write the minimum code to make it pass.\n" +
        "4. Run tests — confirm green.\n" +
        "5. Refactor while staying green.\n\n" +
        "Report each step and the test output before moving on.",
      tags: ["testing", "workflow"],
    },
    {
      id: "hubcode.refactor",
      name: "refactor",
      displayName: "Refactor",
      description: "Improve structure without changing behavior.",
      prompt:
        "Refactor the target code. Rules:\n\n" +
        "- Preserve public behavior and types.\n" +
        "- Keep each step small; run tests/typecheck between steps.\n" +
        "- Name the smell you are addressing (duplication, long method, feature envy, etc.).\n" +
        "- Reject refactors that don't demonstrably reduce complexity.",
      tags: ["refactor", "quality"],
    },
    {
      id: "hubcode.debug",
      name: "debug",
      displayName: "Debug",
      description: "Systematically isolate a bug's root cause.",
      prompt:
        "Debug the reported issue:\n\n" +
        "1. Restate the expected vs. actual behavior.\n" +
        "2. Reproduce — document the minimal repro.\n" +
        "3. Form a hypothesis — name the suspect file/function.\n" +
        "4. Instrument (log, step, bisect) to verify.\n" +
        "5. Fix the root cause, not the symptom.\n" +
        "6. Add a regression test.",
      tags: ["debugging"],
    },
    {
      id: "hubcode.security-review",
      name: "security-review",
      displayName: "Security review",
      description: "Audit changes against the OWASP top-10 and common pitfalls.",
      prompt:
        "Perform a security review of the pending diff. Walk the OWASP Top 10: " +
        "injection, broken auth, sensitive data exposure, XXE, broken access control, " +
        "security misconfiguration, XSS, insecure deserialization, vulnerable deps, " +
        "insufficient logging. Also flag: secrets in code, unsafe shell interpolation, " +
        "SSRF, prototype pollution, and missing auth on new endpoints.",
      tags: ["security", "review"],
    },
    {
      id: "hubcode.explain",
      name: "explain",
      displayName: "Explain code",
      description: "Walk through a file/function clearly for a new contributor.",
      prompt:
        "Explain the target code as if onboarding a new engineer:\n\n" +
        "- Purpose in one paragraph.\n" +
        "- Entry points / public API.\n" +
        "- Data flow and key invariants.\n" +
        "- Gotchas or surprising behavior.\n" +
        "- Where it sits in the broader system.",
      tags: ["docs", "onboarding"],
    },
    {
      id: "hubcode.test",
      name: "test",
      displayName: "Write tests",
      description: "Generate meaningful tests for the selected code.",
      prompt:
        "Write tests for the target code. Requirements:\n\n" +
        "- Cover the happy path, at least two edge cases, and one failure mode.\n" +
        "- Prefer real dependencies over mocks where feasible.\n" +
        "- Use descriptive test names (what + when + expected).\n" +
        "- Run the test suite and report the result.",
      tags: ["testing"],
    },
    {
      id: "hubcode.commit-msg",
      name: "commit-msg",
      displayName: "Commit message",
      description: "Write a tight Conventional-Commit message from the staged diff.",
      prompt:
        "Inspect the staged diff and produce a commit message:\n\n" +
        "- Format: `<type>(<scope>): <subject>` where type ∈ {feat, fix, refactor, perf, test, docs, chore}.\n" +
        "- Subject ≤ 72 chars, imperative mood.\n" +
        "- Body explains *why*, not *what* (diff already shows what).\n" +
        "- Wrap at 100 columns. No marketing adjectives.",
      tags: ["git", "docs"],
    },
    {
      id: "hubcode.pr",
      name: "pr",
      displayName: "Pull request",
      description: "Draft a reviewable PR title and body from the branch diff.",
      prompt:
        "Compare the current branch against the base branch and draft a PR:\n\n" +
        "- Title ≤ 70 chars, Conventional-Commit style.\n" +
        "- Summary: 1-3 bullets of what changed and why.\n" +
        "- Test plan: checklist of what the reviewer should verify.\n" +
        "- Screenshots / logs section if the diff is UI or observability.",
      tags: ["git", "review"],
    },
  ];

  return cmds.map((c) => ({
    ...c,
    author: "builtin" as const,
    scope: "global" as const,
  }));
}

export const BUILTIN_COMMAND_IDS = new Set(buildBuiltinCommands().map((c) => c.id));
