import { describe, expect, it } from "vitest";
import type { AgentAttachment } from "@getpaseo/protocol/messages";
import type { ComposerAttachment } from "@/attachments/types";
import {
  createNativeForkInWorkspace,
  getWorkspaceNamingAttachments,
  remapDraftCwdToWorkspace,
  sendNativeForkPrompt,
} from "./new-workspace-fork-context";

describe("remapDraftCwdToWorkspace", () => {
  it("preserves a Windows subdirectory when source path casing differs", () => {
    expect(
      remapDraftCwdToWorkspace({
        cwd: "c:\\Repo\\packages\\app",
        sourceDirectory: "C:\\Repo",
        workspaceDirectory: "D:\\Worktrees\\fork",
      }),
    ).toBe("D:\\Worktrees\\fork\\packages\\app");
  });

  it("drops the subdirectory when the destination came from a different checkout", () => {
    expect(
      remapDraftCwdToWorkspace({
        cwd: "/repo/packages/app",
        sourceDirectory: "/repo",
        destinationSourceDirectory: "/other-repo",
        workspaceDirectory: "/worktrees/other-fork",
      }),
    ).toBe("/worktrees/other-fork");
  });

  it("keeps the subdirectory when the destination is the same checkout", () => {
    expect(
      remapDraftCwdToWorkspace({
        cwd: "/repo/packages/app",
        sourceDirectory: "/repo/",
        destinationSourceDirectory: "/repo",
        workspaceDirectory: "/worktrees/fork",
      }),
    ).toBe("/worktrees/fork/packages/app");
  });

  it("falls back to the workspace root when the cwd is outside the source directory", () => {
    expect(
      remapDraftCwdToWorkspace({
        cwd: "/other/repo/packages/app",
        sourceDirectory: "/repo",
        workspaceDirectory: "/worktrees/fork",
      }),
    ).toBe("/worktrees/fork");
  });
});

describe("getWorkspaceNamingAttachments", () => {
  it("removes full chat history from workspace naming context", () => {
    const chatHistory = {
      type: "text",
      mimeType: "text/plain",
      contextKind: "chat_history",
      title: "Chat history",
      text: "Long prior conversation",
    } satisfies AgentAttachment;
    const prContext = {
      type: "github_pr",
      mimeType: "application/github-pr",
      number: 1788,
      title: "Fork assistant turns into new drafts",
      url: "https://github.com/getpaseo/paseo/pull/1788",
    } satisfies AgentAttachment;

    expect(getWorkspaceNamingAttachments([chatHistory, prContext])).toEqual([prContext]);
  });
});

describe("createNativeForkInWorkspace", () => {
  it("creates an empty destination and imports native history into its remapped cwd", async () => {
    const createCalls: unknown[] = [];
    const forkCalls: unknown[] = [];

    const result = await createNativeForkInWorkspace({
      client: {
        forkAgentNative: async (agentId, options) => {
          forkCalls.push({ agentId, options });
          return {
            requestId: "request-1",
            agentId,
            forkedAgentId: "forked-agent",
            forkedWorkspaceId: "destination-workspace",
            error: null,
          };
        },
      },
      agentId: "source-agent",
      boundaryMessageId: "assistant-message",
      sourceCwd: "/repo/packages/app",
      sourceDirectory: "/repo",
      destinationSourceDirectory: "/repo",
      prompt: "keep going",
      namingAttachments: [],
      ensureWorkspace: async (options) => {
        createCalls.push(options);
        return {
          id: "destination-workspace",
          workspaceDirectory: "/worktrees/fork",
        };
      },
      failureMessage: "Fork failed",
    });

    expect(createCalls).toEqual([
      {
        cwd: "/repo/packages/app",
        prompt: "keep going",
        attachments: [],
        withInitialAgent: false,
      },
    ]);
    expect(forkCalls).toEqual([
      {
        agentId: "source-agent",
        options: {
          boundaryMessageId: "assistant-message",
          workspaceId: "destination-workspace",
          cwd: "/worktrees/fork/packages/app",
        },
      },
    ]);
    expect(result).toEqual({
      agentId: "forked-agent",
      workspaceId: "destination-workspace",
    });
  });
});

describe("sendNativeForkPrompt", () => {
  const imageAttachment = {
    kind: "image",
    metadata: {
      id: "image-1",
      mimeType: "image/png",
      storageType: "native-file",
      storageKey: "/tmp/shot.png",
      createdAt: 0,
    },
  } satisfies ComposerAttachment;

  it("skips the send when nothing was typed", async () => {
    let sends = 0;
    await sendNativeForkPrompt({
      text: "   ",
      attachments: [],
      send: async () => {
        sends += 1;
      },
      restoreDraft: () => {
        throw new Error("must not restore");
      },
    });
    expect(sends).toBe(0);
  });

  it("hands the prompt to the forked agent's composer when the send fails", async () => {
    const restored: unknown[] = [];
    await expect(
      sendNativeForkPrompt({
        text: "  keep going  ",
        attachments: [imageAttachment],
        send: async () => {
          throw new Error("host disconnected");
        },
        restoreDraft: (draft) => {
          restored.push(draft);
        },
      }),
    ).rejects.toThrow("host disconnected");

    expect(restored).toEqual([{ text: "keep going", attachments: [imageAttachment] }]);
  });

  it("leaves no draft behind when the send succeeds", async () => {
    const sent: unknown[] = [];
    await sendNativeForkPrompt({
      text: "  keep going  ",
      attachments: [imageAttachment],
      send: async (message) => {
        sent.push(message);
      },
      restoreDraft: () => {
        throw new Error("must not restore");
      },
    });
    expect(sent).toEqual([{ text: "keep going", attachments: [imageAttachment] }]);
  });
});
