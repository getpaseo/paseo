import {
  createDraftCreations,
  DraftCreationOutcomeUnknownError,
} from "@/composer/draft/creation-attempt";
import { WorkspaceDescriptorPayloadSchema } from "@getpaseo/protocol/messages";
import { describe, expect, it, vi } from "vitest";
import type { ComposerAttachment } from "@/attachments/types";
import type { MessagePayload } from "@/composer/types";
import { isEmptyWorkspaceSubmission, runCreateEmptyWorkspace } from "./new-workspace-empty";

function payload(
  input: { text?: string; attachments?: ComposerAttachment[] } = {},
): MessagePayload {
  return { text: input.text ?? "", attachments: input.attachments ?? [], cwd: "/sample/repo" };
}

function createRecordingNavigate() {
  const recorded: Array<{ serverId: string; workspaceId: string }> = [];
  return {
    recorded,
    navigate: (serverId: string, workspaceId: string) => {
      recorded.push({ serverId, workspaceId });
    },
  };
}

describe("runCreateEmptyWorkspace", () => {
  it("creates a workspace without prompt or attachments and navigates to it", async () => {
    const workspace = { id: "workspace-123" };
    const ensureWorkspace = vi.fn().mockResolvedValue(workspace);
    const { navigate, recorded } = createRecordingNavigate();

    const retired: string[] = [];
    await runCreateEmptyWorkspace({
      retireWorkspace: async (workspaceId) => {
        retired.push(workspaceId);
      },
      payload: payload(),
      ensureWorkspace,
      serverId: "server-abc",
      navigate,
    });

    expect(retired).toEqual([workspace.id]);
    expect(ensureWorkspace).toHaveBeenCalledOnce();
    expect(ensureWorkspace).toHaveBeenCalledWith({
      cwd: "/sample/repo",
      prompt: "",
      attachments: [],
      withInitialAgent: false,
    });
    expect(recorded).toEqual([{ serverId: "server-abc", workspaceId: "workspace-123" }]);
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

it("empty completion preserves first Chat ownership across a gated admission write and reload", async () => {
  const scope = { serverId: "host-A", draftId: "shared-creation" };
  const workspace = WorkspaceDescriptorPayloadSchema.parse({
    id: "workspace-1",
    projectId: "project",
    projectDisplayName: "Project",
    projectRootPath: "/sample/repo",
    workspaceDirectory: "/sample/repo",
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: "Ready workspace",
    status: "running",
    statusEnteredAt: null,
    activityAt: null,
    archivingAt: null,
    scripts: [],
  });
  let saved: string | null = null;
  let writing!: () => void;
  let persist!: () => void;
  let completeAgent!: () => void;
  const writeStarted = new Promise<void>((resolve) => {
    writing = resolve;
  });
  const releaseWrite = new Promise<void>((resolve) => {
    persist = resolve;
  });
  const agentNetwork = new Promise<void>((resolve) => {
    completeAgent = resolve;
  });
  const storage = {
    getItem: async () => saved,
    setItem: async (_key: string, value: string) => {
      if (JSON.parse(value).attempt?.kind === "agent") {
        writing();
        await releaseWrite;
      }
      saved = value;
    },
  };
  const dependencies = {
    storage,
    outcomeUnknownMessage: () => "Previous creation is unresolved",
    isNotSent: () => false,
    onPersistenceError: () => {},
  };
  const creations = createDraftCreations(dependencies);
  const workspaceRequest = { source: { kind: "directory", path: workspace.workspaceDirectory } };
  await creations.submit({
    ...scope,
    kind: "workspace",
    request: workspaceRequest,
    send: async ({ idempotencyKey, onEvent }) => {
      onEvent({
        kind: "workspace",
        idempotencyKey,
        phase: "completed",
        revision: 1,
        workspaceId: workspace.id,
        agentId: null,
        workspace,
        error: null,
      });
    },
  });
  let owner: string | undefined = scope.draftId;
  const agentRequest = { workspaceId: workspace.id, initialPrompt: "First Chat" };
  const agent = creations.submit({
    ...scope,
    kind: "agent",
    request: agentRequest,
    onAdmitted: async () => {
      owner = scope.draftId;
    },
    send: async () => agentNetwork,
  });
  await writeStarted;
  let retirementChecks = 0;
  const { recorded, navigate } = createRecordingNavigate();
  const completion = runCreateEmptyWorkspace({
    payload: payload(),
    serverId: scope.serverId,
    ensureWorkspace: vi.fn().mockResolvedValue(workspace),
    navigate,
    retireWorkspace: async (workspaceId) => {
      retirementChecks += 1;
      await creations.retireWorkspace({
        ...scope,
        workspaceId,
        retire: () => {
          owner = undefined;
        },
      });
    },
  });
  persist();
  await completion;
  expect(retirementChecks).toBe(1);
  expect(owner).toBe(scope.draftId);
  expect(recorded).toEqual([{ serverId: scope.serverId, workspaceId: workspace.id }]);
  const restored = createDraftCreations(dependencies);
  await expect(restored.workspaceRetry({ ...scope, request: workspaceRequest })).rejects.toThrow(
    DraftCreationOutcomeUnknownError,
  );
  let duplicateStarts = 0;
  await expect(
    restored.submit({
      ...scope,
      kind: "agent",
      request: { ...agentRequest, initialPrompt: "Edited Chat" },
      send: async () => {
        duplicateStarts += 1;
      },
    }),
  ).rejects.toThrow(DraftCreationOutcomeUnknownError);
  expect(duplicateStarts).toBe(0);
  completeAgent();
  await agent;
});
