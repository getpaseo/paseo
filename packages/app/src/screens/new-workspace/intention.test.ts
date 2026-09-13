import { describe, expect, it, vi } from "vitest";
import { runCreateIntentionWorkspace } from "../new-workspace-empty";
import { resolveLaunchTarget } from "@/new-workspace-launch/target";
import { parseFormPreferences } from "@/create-agent-preferences/preferences";
import { normalizeWorkspaceTabTarget, workspaceTabTargetsEqual } from "@/workspace-tabs/identity";

describe("workspace intention", () => {
  it("round trips the target only on a capable host", () => {
    const target = { kind: "intention" } as const;
    expect(parseFormPreferences({ launchTarget: target }).launchTarget).toEqual(target);
    expect(resolveLaunchTarget(target, [], true)).toEqual(target);
    expect(resolveLaunchTarget(target, [], false)).toEqual({ kind: "chat" });
  });

  it("creates no initial agent and preserves text in an unsent Router draft", async () => {
    const ensureWorkspace = vi
      .fn()
      .mockResolvedValue({ id: "workspace", workspaceDirectory: "/worktree" });
    const saveDraft = vi.fn();
    const openDraft = vi.fn();
    await runCreateIntentionWorkspace({
      payload: { cwd: "/repo", text: "  Build a calendar\nwith holidays  ", attachments: [] },
      ensureWorkspace,
      draftId: "draft-router",
      profile: {
        id: "paseo-workflow-router",
        provider: "codex",
        modelId: "gpt-5",
        modeId: "plan",
        thinkingOptionId: "high",
        featureValues: { webSearch: true },
      },
      saveDraft,
      openDraft,
    });
    expect(ensureWorkspace).toHaveBeenCalledExactlyOnceWith({
      cwd: "/repo",
      prompt: "",
      attachments: [],
      withInitialAgent: false,
      intent: "  Build a calendar\nwith holidays  ",
    });
    expect(saveDraft).toHaveBeenCalledExactlyOnceWith({
      text: "  Build a calendar\nwith holidays  ",
      attachments: [],
    });
    const target = {
      kind: "draft",
      draftId: "draft-router",
      setup: {
        provider: "codex",
        cwd: "/worktree",
        model: "gpt-5",
        modeId: "plan",
        thinkingOptionId: "high",
        featureValues: { webSearch: true },
        launchProfileId: "paseo-workflow-router",
      },
    } as const;
    expect(openDraft).toHaveBeenCalledExactlyOnceWith("workspace", target);
    expect(normalizeWorkspaceTabTarget(target)).toEqual(target);
    expect(
      workspaceTabTargetsEqual(target, {
        ...target,
        setup: { ...target.setup, launchProfileId: "other" },
      }),
    ).toBe(false);
  });

  it("does not create a workspace when the Router profile is unavailable", async () => {
    const ensureWorkspace = vi.fn();
    await expect(
      runCreateIntentionWorkspace({
        payload: { cwd: "/repo", text: "Plan", attachments: [] },
        draftId: "draft",
        profile: undefined,
        ensureWorkspace,
        saveDraft: vi.fn(),
        openDraft: vi.fn(),
      }),
    ).rejects.toThrow();
    expect(ensureWorkspace).not.toHaveBeenCalled();
  });
});
