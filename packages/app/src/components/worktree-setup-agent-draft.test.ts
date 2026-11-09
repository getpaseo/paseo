import { beforeEach, describe, expect, it } from "vitest";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { useDraftStore } from "@/stores/draft-store";
import {
  prepareWorktreeSetupAgentDraft,
  WORKTREE_SETUP_AGENT_PROMPT,
} from "./worktree-setup-agent-draft";

describe("prepareWorktreeSetupAgentDraft", () => {
  beforeEach(() => {
    useDraftStore.setState({ drafts: {} });
  });

  it("opens a draft tab whose composer already holds the setup prompt", () => {
    const target = prepareWorktreeSetupAgentDraft("server-1");

    // The draft tab reads its composer from this key (composer/draft/workspace-tab.tsx).
    const draftKey = buildDraftStoreKey({
      serverId: "server-1",
      agentId: target.draftId,
      draftId: target.draftId,
    });
    expect(target.kind).toBe("draft");
    expect(useDraftStore.getState().getDraftInput(draftKey)).toEqual({
      text: WORKTREE_SETUP_AGENT_PROMPT,
      attachments: [],
    });
  });

  it("starts a fresh draft each time instead of reusing an edited one", () => {
    const first = prepareWorktreeSetupAgentDraft("server-1");
    const second = prepareWorktreeSetupAgentDraft("server-1");

    expect(second.draftId).not.toBe(first.draftId);
  });
});
