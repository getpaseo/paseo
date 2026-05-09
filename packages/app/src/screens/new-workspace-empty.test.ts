import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ComposerAttachment } from "@/attachments/types";
import type { MessagePayload } from "@/components/message-input";

const navigateToWorkspace = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-workspace-navigation", () => ({ navigateToWorkspace }));

let isEmptyWorkspaceSubmission: typeof import("./new-workspace-empty").isEmptyWorkspaceSubmission;
let runCreateEmptyWorkspace: typeof import("./new-workspace-empty").runCreateEmptyWorkspace;

beforeAll(async () => {
  ({ isEmptyWorkspaceSubmission, runCreateEmptyWorkspace } = await import("./new-workspace-empty"));
});

function payload(
  input: { text?: string; attachments?: ComposerAttachment[] } = {},
): MessagePayload {
  return { text: input.text ?? "", attachments: input.attachments ?? [], cwd: "/sample/repo" };
}

describe("runCreateEmptyWorkspace", () => {
  it("creates a workspace without prompt or attachments and navigates to it", async () => {
    const workspace = { id: "workspace-123" };
    const ensureWorkspace = vi.fn().mockResolvedValue(workspace);

    await runCreateEmptyWorkspace({ payload: payload(), ensureWorkspace, serverId: "server-abc" });

    expect(ensureWorkspace).toHaveBeenCalledOnce();
    expect(ensureWorkspace).toHaveBeenCalledWith({
      cwd: "/sample/repo",
      prompt: "",
      attachments: [],
    });
    expect(navigateToWorkspace).toHaveBeenCalledOnce();
    expect(navigateToWorkspace).toHaveBeenCalledWith("server-abc", workspace.id);
  });
});

describe("isEmptyWorkspaceSubmission", () => {
  it("treats whitespace-only text with no attachments as empty, but any attachment as non-empty", () => {
    const attachment: ComposerAttachment = {
      kind: "image",
      metadata: {
        id: "image-1",
        mimeType: "image/png",
        storageType: "web-indexeddb",
        storageKey: "image-1",
        createdAt: 0,
      },
    };

    expect(isEmptyWorkspaceSubmission(payload({ text: " \n\t " }))).toBe(true);
    expect(isEmptyWorkspaceSubmission(payload({ attachments: [attachment] }))).toBe(false);
  });
});
