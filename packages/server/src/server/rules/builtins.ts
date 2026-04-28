import type { HubcodeRule } from "./types.js";

/**
 * Default rules Hubcode ships for software-engineering work. Conservative,
 * widely applicable, and opt-out friendly (every one can be toggled off).
 */
export function buildBuiltinRules(): HubcodeRule[] {
  const rules: Array<Omit<HubcodeRule, "id" | "author" | "scope"> & { id: string }> = [
    {
      id: "hubcode.typecheck-after-changes",
      title: "Run typecheck after code changes",
      description: "Catch type errors before reporting a task as done.",
      body:
        "After editing TypeScript/JavaScript code, run the project's typecheck " +
        "command (e.g. `npm run typecheck`) and surface any errors. Never claim a " +
        "task is finished without a clean typecheck.",
      tags: ["quality", "typescript"],
    },
    {
      id: "hubcode.format-before-commit",
      title: "Format before committing",
      description: "Let the formatter own whitespace, never hand-fix it.",
      body:
        "Run the repo formatter (Biome, Prettier, gofmt, rustfmt, etc.) before " +
        "every commit. Do not manually reformat code — the formatter is the source " +
        "of truth for style.",
      tags: ["quality", "git"],
    },
    {
      id: "hubcode.prefer-edit-over-create",
      title: "Prefer editing existing files",
      description: "Don't create new files when an existing one will do.",
      body:
        "Default to editing existing files. Create new files only when the change " +
        "introduces a new abstraction that clearly doesn't belong in any current " +
        "file. Never duplicate documentation, helpers, or types.",
      tags: ["quality"],
    },
    {
      id: "hubcode.root-cause-debugging",
      title: "Fix root causes, not symptoms",
      description: "Shortcuts and try/catch swallows come back as bugs.",
      body:
        "When debugging, keep going until you've identified the actual root cause. " +
        "Do not silence errors with broad try/catch, swallow warnings, or add " +
        "retries unless you understand why the first attempt failed.",
      tags: ["debugging", "quality"],
    },
    {
      id: "hubcode.tests-as-you-change",
      title: "Update tests alongside code",
      description: "Keep tests and source in lockstep.",
      body:
        "Any non-trivial change to production code must include updated or new " +
        "tests in the same diff. If the test cost is prohibitive, stop and " +
        "confirm the scope with the user before proceeding.",
      tags: ["testing", "quality"],
    },
    {
      id: "hubcode.no-unexplained-magic",
      title: "No unexplained magic numbers or flags",
      description: "Name constants or document the reasoning inline.",
      body:
        "Replace bare numeric/boolean constants with named symbols OR add a " +
        "short comment explaining the provenance of the value. `timeout = 7431` " +
        "with no context is a code smell.",
      tags: ["quality"],
    },
    {
      id: "hubcode.dangerous-ops-confirm",
      title: "Confirm destructive or hard-to-reverse actions",
      description: "Rm -rf, git reset --hard, dropping tables, force-push, etc.",
      body:
        "Before running any command that is destructive, hard-to-reverse, or " +
        "affects shared state (force-push, rm -rf, DB drops, prod deploys), " +
        "state exactly what you intend and wait for explicit user confirmation.",
      tags: ["safety"],
    },
    {
      id: "hubcode.cite-file-line",
      title: "Cite file:line when discussing code",
      description: "Precise references keep reviews fast.",
      body:
        "When referring to specific code in a response, use the `path/to/file.ext:123` " +
        "format so reviewers can jump straight to the relevant line.",
      tags: ["communication"],
    },
  ];
  return rules.map((r) => ({ ...r, author: "builtin" as const, scope: "global" as const }));
}

export const BUILTIN_RULE_IDS = new Set(buildBuiltinRules().map((r) => r.id));
