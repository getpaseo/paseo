import { buildDraftStoreKey, generateDraftId } from "@/stores/draft-keys";
import { useDraftStore } from "@/stores/draft-store";
import { buildDeterministicWorkspaceTabId } from "@/workspace-tabs/identity";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";

// Sent to an agent, not shown as UI copy, so it stays untranslated.
export const WORKTREE_SETUP_AGENT_PROMPT = `Set up Paseo worktree config for this repository.

Read the Paseo docs first (use the paseo-help skill if you have it):
- https://paseo.sh/docs/worktrees
- https://paseo.sh/docs/worktrees/worktreeinclude

Inspect this repo and create or update \`paseo.json\` in the repo root with the best worktree config for it.

Requirements:
- If \`paseo.json\` already exists, keep its existing settings unless they are clearly wrong.
- Set \`worktree.setup\` to install dependencies and prepare a fresh worktree. Add \`worktree.teardown\` only if something needs cleaning up when a worktree is archived.
- Add \`scripts\` for the commands people run day to day, such as the dev server, tests, lint and typecheck.
- Mark long-running dev servers as \`"type": "service"\` and bind them to \`$PASEO_PORT\` when the project supports a configurable port, so several worktrees can run at once.
- If setup needs gitignored local files such as \`.env\`, list them in \`.worktreeinclude\` instead of copying them in setup. Use \`$PASEO_SOURCE_CHECKOUT_PATH\` only for what \`.worktreeinclude\` can't cover.
- Follow the repo's existing package manager, lockfile, scripts and setup conventions.
- Keep commands simple, non-interactive, non-destructive and safe to run inside a worktree.

Inspect the usual sources: package files, lockfiles, README/CONTRIBUTING docs, Makefile/justfile/Taskfile, Docker/Procfile config, and existing \`scripts/\` or \`bin/\`.

Paseo reads \`paseo.json\` from the committed base branch, usually \`main\`, so new worktrees only pick it up once it is committed there. If this workspace is on another branch, tell me. Ask me before committing or merging.

After editing, validate the JSON and summarise what you configured and why. Then give me one quick test: get \`paseo.json\` onto the base branch, create a new worktree workspace, and check its Setup tab.`;

/** Seeds a new draft with the worktree-setup prompt and returns the tab target that shows it. */
export function prepareWorktreeSetupAgentDraft(
  serverId: string,
): Extract<WorkspaceTabTarget, { kind: "draft" }> {
  const target = { kind: "draft", draftId: generateDraftId() } as const;
  useDraftStore.getState().saveDraftInput({
    draftKey: buildDraftStoreKey({
      serverId,
      agentId: buildDeterministicWorkspaceTabId(target),
      draftId: target.draftId,
    }),
    draft: { text: WORKTREE_SETUP_AGENT_PROMPT, attachments: [] },
  });
  return target;
}
