import { CreationClient } from "../../../../client/src/creation/index";
import { describe, expect, it } from "vitest";
import { draftCreationKey } from "./creation-key";
import { createDraftCreations, DraftCreationOutcomeUnknownError } from "./creation-attempt";
import type { CreationSnapshot } from "@getpaseo/protocol/messages";
import { WorkspaceDescriptorPayloadSchema } from "@getpaseo/protocol/messages";

const request = {
  config: { provider: "codex", cwd: "/repo", model: "gpt-6" },
  workspaceId: "workspace-1",
  initialPrompt: "Start the original task.",
  clientMessageId: "draft-1:initial-message",
};

const worktreeRequest = {
  source: {
    kind: "worktree" as const,
    cwd: "/repo",
    projectId: "prj_1",
    worktreeSlug: "clever-fox",
  },
  firstAgentContext: { prompt: "Start the original task.", attachments: [] },
  agent: {
    config: { provider: "codex", cwd: "/repo", model: "gpt-6" },
    initialPrompt: "Start the original task.",
    clientMessageId: "draft-1:initial-message",
  },
};

describe("draftCreationKey", () => {
  it("keeps the key for a retry of the same request, whatever its key order", () => {
    const reordered = {
      clientMessageId: request.clientMessageId,
      initialPrompt: request.initialPrompt,
      workspaceId: request.workspaceId,
      config: { model: "gpt-6", cwd: "/repo", provider: "codex" },
    };
    expect(draftCreationKey("draft-1", reordered)).toBe(draftCreationKey("draft-1", request));
  });

  it.each([
    { name: "prompt", edited: { ...request, initialPrompt: "Start the edited task." } },
    { name: "model", edited: { ...request, config: { ...request.config, model: "gpt-6-mini" } } },
  ])("gives an edited $name a new key on the same draft", ({ edited }) => {
    const key = draftCreationKey("draft-1", edited);
    expect(key).not.toBe(draftCreationKey("draft-1", request));
    expect(key.startsWith("draft-1:")).toBe(true);
  });

  it.each([
    {
      name: "isolation",
      edited: {
        ...worktreeRequest,
        source: { kind: "directory" as const, path: "/repo", projectId: "prj_1" },
      },
    },
    {
      name: "project",
      edited: {
        ...worktreeRequest,
        source: { ...worktreeRequest.source, projectId: "prj_2", cwd: "/other" },
      },
    },
    {
      name: "prompt",
      edited: {
        ...worktreeRequest,
        firstAgentContext: { prompt: "hi", attachments: [] },
        agent: { ...worktreeRequest.agent, initialPrompt: "hi" },
      },
    },
  ])(
    "gives a New workspace request with edited $name a new key on the same draft",
    ({ edited }) => {
      const key = draftCreationKey("draft-1", edited);
      expect(key).not.toBe(draftCreationKey("draft-1", worktreeRequest));
      expect(key.startsWith("draft-1:")).toBe(true);
    },
  );

  it("gives a New workspace request with a changed launch target a new key even when the wire request matches", () => {
    const emptyRequest = {
      source: { kind: "directory" as const, path: "/repo", projectId: "prj_1" },
    };
    const chatKey = draftCreationKey("draft-1", {
      request: emptyRequest,
      launchTarget: { kind: "chat" },
    });
    const terminalKey = draftCreationKey("draft-1", {
      request: emptyRequest,
      launchTarget: { kind: "terminal", profileId: "shell" },
    });
    expect(terminalKey).not.toBe(chatKey);
    expect(terminalKey.startsWith("draft-1:")).toBe(true);
  });
});

class NotSentError extends Error {}

function creationsFor(disk: Parameters<typeof createDraftCreations>[0]["storage"]) {
  return createDraftCreations({
    storage: disk,
    outcomeUnknownMessage: () => "Check the previous start before creating another.",
    isNotSent: (error) => error instanceof NotSentError,
    onPersistenceError: () => {},
  });
}

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

function failure(options: {
  kind: CreationSnapshot["kind"];
  idempotencyKey: string;
  unknown: boolean;
}): CreationSnapshot {
  return {
    kind: options.kind,
    idempotencyKey: options.idempotencyKey,
    phase: "failed",
    revision: 2,
    workspaceId: "workspace-1",
    agentId: null,
    error: "Startup failed",
    outcomeUnknown: options.unknown,
  };
}

const scope = { serverId: "host", draftId: "draft-1" };

describe("draft creation retry admission", () => {
  it.each(["pending", "unknown"] as const)(
    "rejects workspace-only reuse while the original agent outcome is %s after reload",
    async (outcome) => {
      const disk = storage();
      const workspace = WorkspaceDescriptorPayloadSchema.parse({
        id: "workspace-1",
        projectId: "project",
        projectDisplayName: "Project",
        projectRootPath: "/repo",
        workspaceDirectory: "/repo",
        projectKind: "git",
        workspaceKind: "local_checkout",
        name: "Ready workspace",
        status: "running",
        statusEnteredAt: null,
        activityAt: null,
        archivingAt: null,
        scripts: [],
      });
      const source = { kind: "directory", path: "/repo", projectId: "project" };
      const originalRequest = { source, agent: request };
      await expect(
        creationsFor(disk).submit({
          ...scope,
          kind: "workspace",
          request: originalRequest,
          send: async ({ idempotencyKey, onEvent }) => {
            onEvent({
              ...failure({ kind: "workspace", idempotencyKey, unknown: true }),
              phase: outcome === "pending" ? "workspace_ready" : "failed",
              workspace,
            });
            throw new Error("Disconnected from the original start");
          },
        }),
      ).rejects.toThrow("Disconnected from the original start");
      const restored = creationsFor(disk);
      await expect(restored.workspaceRetry({ ...scope, request: { source } })).rejects.toThrow(
        DraftCreationOutcomeUnknownError,
      );
      expect(await restored.workspaceRetry({ ...scope, request: originalRequest })).toEqual({
        kind: "replay",
      });
      await expect(
        restored.submit({
          ...scope,
          kind: "agent",
          request: { ...request, initialPrompt: "Edited task" },
          send: async () => "must-not-create",
        }),
      ).rejects.toThrow(DraftCreationOutcomeUnknownError);
    },
  );

  it.each([
    { initialAgent: false, phase: "workspace_ready" },
    { initialAgent: false, phase: "completed" },
    { initialAgent: true, phase: "workspace_ready" },
    { initialAgent: true, phase: "completed" },
  ] as const)(
    "admits only a first agent after workspace-only creation ($phase, initial agent: $initialAgent)",
    async ({ initialAgent, phase }) => {
      const disk = storage();
      const workspace = WorkspaceDescriptorPayloadSchema.parse({
        id: "workspace-1",
        projectId: "project",
        projectDisplayName: "Project",
        projectRootPath: "/repo",
        workspaceDirectory: "/repo",
        projectKind: "git",
        workspaceKind: "local_checkout",
        name: "Ready workspace",
        status: "running",
        statusEnteredAt: null,
        activityAt: null,
        archivingAt: null,
        scripts: [],
      });
      const source = { kind: "directory", path: "/repo", projectId: "project" };
      await creationsFor(disk).submit({
        ...scope,
        kind: "workspace",
        request: { source, ...(initialAgent ? { agent: request } : {}) },
        send: async ({ idempotencyKey, onEvent }) => {
          onEvent({
            ...failure({ kind: "workspace", idempotencyKey, unknown: false }),
            phase,
            error: null,
            workspace,
          });
        },
      });
      const restored = creationsFor(disk);
      expect(
        await restored.workspaceRetry({ ...scope, request: { source, agent: request } }),
      ).toEqual(initialAgent ? { kind: "replay" } : { kind: "reuse", workspace });
      let dispatched = 0;
      const attempt = restored.submit({
        ...scope,
        kind: "agent",
        request,
        send: async () => {
          dispatched++;
          return "first-chat-agent";
        },
      });
      const result = await attempt.then(
        (value) => value,
        (error) =>
          error instanceof DraftCreationOutcomeUnknownError ? "blocked" : Promise.reject(error),
      );
      expect(result).toBe(initialAgent ? "blocked" : "first-chat-agent");
      expect(dispatched).toBe(initialAgent ? 0 : 1);
    },
  );

  it("retains a background-ready workspace across reload and retries only its agent after definite failure", async () => {
    const disk = storage();
    const workspace = WorkspaceDescriptorPayloadSchema.parse({
      id: "workspace-1",
      projectId: "project",
      projectDisplayName: "Project",
      projectRootPath: "/repo",
      workspaceDirectory: "/repo/worktree",
      projectKind: "git",
      workspaceKind: "worktree",
      name: "Existing workspace",
      status: "running",
      statusEnteredAt: null,
      activityAt: null,
      archivingAt: null,
      scripts: [],
    });
    let workspaceCreates = 0;
    const original = creationsFor(disk);
    const source = {
      kind: "worktree",
      cwd: "/repo",
      projectId: "project",
      worktreeSlug: "retained",
      branchName: "original",
      baseBranch: "main",
    };
    const workspaceRequest = { source, agent: request };
    await original.submit({
      ...scope,
      kind: "workspace",
      request: workspaceRequest,
      send: async ({ idempotencyKey, onEvent }) => {
        workspaceCreates++;
        onEvent({
          ...failure({ kind: "workspace", idempotencyKey, unknown: false }),
          phase: "workspace_ready",
          revision: 1,
          error: null,
          workspace,
        });
        onEvent(failure({ kind: "workspace", idempotencyKey, unknown: false }));
      },
    });
    const restored = creationsFor(disk);
    expect(await restored.workspaceRetry({ ...scope, request: workspaceRequest })).toEqual({
      kind: "replay",
    });
    expect(
      await restored.workspaceRetry({
        ...scope,
        request: { ...workspaceRequest, agent: { ...request, initialPrompt: "Edited" } },
      }),
    ).toEqual({ kind: "reuse", workspace });
    for (const changedSource of [
      { ...source, projectId: "other-project" },
      { ...source, cwd: "/other-repo" },
      { ...source, branchName: "other-branch" },
      { ...source, baseBranch: "other-base" },
      { kind: "directory", path: "/repo", projectId: "project" },
    ]) {
      await expect(
        restored.workspaceRetry({
          ...scope,
          request: { ...workspaceRequest, source: changedSource },
        }),
      ).rejects.toThrow("Workspace placement has changed");
    }
    const result = await restored.submit({
      ...scope,
      kind: "agent",
      request: {
        ...request,
        initialPrompt: "Edited after background failure",
        workspaceId: workspace.id,
      },
      send: async () => "agent-in-existing-workspace",
    });
    expect(result).toBe("agent-in-existing-workspace");
    expect(workspaceCreates).toBe(1);
  });

  it("retains a committed workspace when its separate legacy agent frame is not sent", async () => {
    const disk = storage();
    const workspace = WorkspaceDescriptorPayloadSchema.parse({
      id: "workspace-1",
      projectId: "project",
      projectDisplayName: "Project",
      projectRootPath: "/repo",
      workspaceDirectory: "/repo",
      projectKind: "git",
      workspaceKind: "local_checkout",
      name: "Existing workspace",
      status: "running",
      statusEnteredAt: null,
      activityAt: null,
      archivingAt: null,
      scripts: [],
    });
    const workspaceRequest = { source: { kind: "directory", path: "/repo" }, agent: request };
    await expect(
      creationsFor(disk).submit({
        ...scope,
        kind: "workspace",
        request: workspaceRequest,
        send: async ({ idempotencyKey, onEvent }) => {
          onEvent({
            ...failure({ kind: "workspace", idempotencyKey, unknown: false }),
            phase: "workspace_ready",
            revision: 1,
            error: null,
            workspace,
          });
          throw new NotSentError("Message is too large to send");
        },
      }),
    ).rejects.toThrow("Message is too large to send");
    const restored = creationsFor(disk);
    expect(await restored.workspaceRetry({ ...scope, request: workspaceRequest })).toEqual({
      kind: "reuse",
      workspace,
    });
    expect(
      await restored.workspaceRetry({
        ...scope,
        request: { ...workspaceRequest, agent: { ...request, initialPrompt: "Smaller prompt" } },
      }),
    ).toEqual({ kind: "reuse", workspace });
    let retirements = 0;
    const retirement = {
      ...scope,
      workspaceId: workspace.id,
      retire: () => {
        retirements += 1;
      },
    };
    expect(
      await restored.retireWorkspace({ ...retirement, workspaceId: "another-workspace" }),
    ).toBe(false);
    expect(await restored.retireWorkspace(retirement)).toBe(true);
    expect(retirements).toBe(1);
    expect(
      await restored.submit({
        ...scope,
        kind: "agent",
        request: { ...request, initialPrompt: "Smaller prompt" },
        send: async () => "created-in-retained-workspace",
      }),
    ).toBe("created-in-retained-workspace");
    expect(await restored.retireWorkspace(retirement)).toBe(false);
    expect(retirements).toBe(1);
  });

  it("does not send when admission cannot be persisted", async () => {
    let starts = 0;
    let writable = false;
    const creations = creationsFor({
      getItem: async () => null,
      setItem: async () => {
        if (!writable) throw new Error("Storage unavailable");
      },
    });
    await expect(
      creations.submit({
        ...scope,
        kind: "agent",
        request,
        send: async () => {
          starts++;
        },
      }),
    ).rejects.toThrow("Storage unavailable");
    expect(starts).toBe(0);
    writable = true;
    const retried = await creations.submit({
      ...scope,
      kind: "agent",
      request: { ...request, initialPrompt: "Edited after storage recovered" },
      send: async () => {
        starts++;
        return "started";
      },
    });
    expect(retried).toBe("started");
    expect(starts).toBe(1);
  });

  it("restores admission when a storage rejection occurred after committing the pending record", async () => {
    const disk = storage();
    let failOnce = true;
    const creations = creationsFor({
      getItem: disk.getItem,
      setItem: async (key, value) => {
        await disk.setItem(key, value);
        if (failOnce) {
          failOnce = false;
          throw new Error("Write acknowledgement lost");
        }
      },
    });
    await expect(
      creations.submit({
        ...scope,
        kind: "agent",
        request,
        send: async () => {
          throw new Error("Must not send");
        },
      }),
    ).rejects.toThrow("Write acknowledgement lost");
    const result = await creationsFor(disk).submit({
      ...scope,
      kind: "agent",
      request: { ...request, initialPrompt: "Edited after admission failed" },
      send: async () => "created",
    });
    expect(result).toBe("created");
  });

  it("keeps a successful host result when later checkpoints fail, independently of other drafts", async () => {
    const disk = storage();
    const counts = new Map<string, number>();
    const creations = creationsFor({
      getItem: disk.getItem,
      setItem: async (key, value) => {
        const count = (counts.get(key) ?? 0) + 1;
        counts.set(key, count);
        if (count === 2) throw new Error("Checkpoint unavailable");
        await disk.setItem(key, value);
      },
    });
    const results = await Promise.all([
      creations.submit({
        ...scope,
        kind: "agent",
        request,
        send: async ({ idempotencyKey, onEvent }) => {
          onEvent({
            ...failure({ kind: "agent", idempotencyKey, unknown: false }),
            phase: "completed",
            error: null,
          });
          return "created-agent";
        },
      }),
      creations.submit({
        ...scope,
        draftId: "other-draft",
        kind: "agent",
        request,
        send: async () => "other-created-agent",
      }),
    ]);
    expect(results).toEqual(["created-agent", "other-created-agent"]);
    await expect(
      creationsFor(disk).submit({
        ...scope,
        kind: "agent",
        request: { ...request, initialPrompt: "Edited after reload" },
        send: async () => "must-not-create",
      }),
    ).rejects.toThrow(DraftCreationOutcomeUnknownError);
  });

  it.each(["agent", "workspace"] as const)(
    "rolls back local %s preflight failures across reload",
    async (kind) => {
      const disk = storage();
      await expect(
        creationsFor(disk).submit({
          ...scope,
          kind,
          request: { ...request, metadata: { plugin: true } },
          send: async () => {
            throw new NotSentError("Update the host to use metadata.");
          },
        }),
      ).rejects.toThrow("Update the host to use metadata.");
      const result = await creationsFor(disk).submit({
        ...scope,
        kind,
        request,
        send: async () => "created-after-correction",
      });
      expect(result).toBe("created-after-correction");
    },
  );

  it("replays an unchanged worktree creation after remount with its original generated slug", async () => {
    const disk = storage();
    const original = creationsFor(disk);
    const slug = await original.worktreeSlug({ ...scope, proposed: "original-worktree" });
    const firstRequest = { source: { kind: "worktree", cwd: "/repo", worktreeSlug: slug } };
    let firstKey = "";
    await expect(
      original.submit({
        ...scope,
        kind: "workspace",
        request: firstRequest,
        send: async ({ idempotencyKey }) => {
          firstKey = idempotencyKey;
          throw new Error("Request timed out");
        },
      }),
    ).rejects.toThrow("Request timed out");
    const remounted = creationsFor(disk);
    const retained = await remounted.worktreeSlug({
      ...scope,
      proposed: "newly-generated-worktree",
    });
    expect(retained).toBe("original-worktree");
    const key = await remounted.submit({
      ...scope,
      kind: "workspace",
      request: { source: { kind: "worktree", cwd: "/repo", worktreeSlug: retained } },
      send: async ({ idempotencyKey }) => idempotencyKey,
    });
    expect(key).toBe(firstKey);
  });

  it.each(["agent", "workspace"] as const)(
    "blocks edited %s submissions after an unknown outcome, including after app restart",
    async (kind) => {
      const disk = storage();
      const creations = creationsFor(disk);
      const first = await creations.submit({
        ...scope,
        kind,
        request,
        send: async ({ idempotencyKey, onEvent }) => {
          onEvent(failure({ kind, idempotencyKey, unknown: true }));
          return "failed";
        },
      });
      expect(first).toBe("failed");
      const remounted = creationsFor(disk);
      let starts = 0;
      await expect(
        remounted.submit({
          ...scope,
          kind,
          request: { ...request, initialPrompt: "An edited task" },
          send: async () => {
            starts++;
          },
        }),
      ).rejects.toThrow(DraftCreationOutcomeUnknownError);
      expect(starts).toBe(0);
    },
  );

  it("does not turn an uncertain workspace agent start into a new agent creation", async () => {
    const disk = storage();
    const creations = creationsFor(disk);
    await creations.submit({
      ...scope,
      kind: "workspace",
      request: { source: { kind: "directory", path: "/repo" }, agent: request },
      send: async ({ idempotencyKey, onEvent }) => {
        onEvent(failure({ kind: "workspace", idempotencyKey, unknown: true }));
      },
    });
    let starts = 0;
    await expect(
      creationsFor(disk).submit({
        ...scope,
        kind: "agent",
        request,
        send: async () => {
          starts++;
        },
      }),
    ).rejects.toThrow("Check the previous start before creating another.");
    expect(starts).toBe(0);
  });

  it.each(["agent", "workspace"] as const)(
    "allows edits after a confirmed %s failure and retains the edited retry key",
    async (kind) => {
      const creations = creationsFor(storage());
      const keys: string[] = [];
      const send = async ({
        idempotencyKey,
        onEvent,
      }: {
        idempotencyKey: string;
        onEvent: (snapshot: CreationSnapshot) => void;
      }) => {
        keys.push(idempotencyKey);
        onEvent(failure({ kind, idempotencyKey, unknown: false }));
      };
      await creations.submit({ ...scope, kind, request, send });
      const edited = { ...request, initialPrompt: "The corrected task" };
      await creations.submit({ ...scope, kind, request: edited, send });
      await creations.submit({ ...scope, kind, request: edited, send });
      expect(keys).toEqual([
        draftCreationKey(scope.draftId, request),
        draftCreationKey(scope.draftId, edited),
        draftCreationKey(scope.draftId, edited),
      ]);
    },
  );

  it("retains the original key after a timeout and refuses an edited send", async () => {
    const disk = storage();
    const creations = creationsFor(disk);
    let firstKey = "";
    await expect(
      creations.submit({
        ...scope,
        kind: "agent",
        request,
        send: async ({ idempotencyKey }) => {
          firstKey = idempotencyKey;
          throw new Error("Request timed out");
        },
      }),
    ).rejects.toThrow("Request timed out");
    const restarted = creationsFor(disk);
    let starts = 0;
    await expect(
      restarted.submit({
        ...scope,
        kind: "agent",
        request: { ...request, initialPrompt: "Edited after timeout" },
        send: async () => {
          starts++;
        },
      }),
    ).rejects.toThrow(DraftCreationOutcomeUnknownError);
    expect(starts).toBe(0);
    const recovered = await restarted.submit({
      ...scope,
      kind: "agent",
      request,
      send: async ({ idempotencyKey }) => idempotencyKey,
    });
    expect(recovered).toBe(firstKey);
  });

  it("ignores old operation events once a confirmed failure has admitted an edit", async () => {
    const creations = creationsFor(storage());
    let oldEvent: (snapshot: CreationSnapshot) => void = () => {};
    let oldKey = "";
    await creations.submit({
      ...scope,
      kind: "agent",
      request,
      send: async ({ idempotencyKey, onEvent }) => {
        oldKey = idempotencyKey;
        oldEvent = onEvent;
        onEvent(failure({ kind: "agent", idempotencyKey, unknown: false }));
      },
    });
    const edited = { ...request, initialPrompt: "Second attempt" };
    await creations.submit({
      ...scope,
      kind: "agent",
      request: edited,
      send: async ({ idempotencyKey, onEvent }) => {
        onEvent(failure({ kind: "agent", idempotencyKey, unknown: true }));
        oldEvent({
          ...failure({ kind: "agent", idempotencyKey: oldKey, unknown: false }),
          revision: 3,
        });
      },
    });
    let starts = 0;
    await expect(
      creations.submit({
        ...scope,
        kind: "agent",
        request: { ...request, initialPrompt: "Third attempt" },
        send: async () => {
          starts++;
        },
      }),
    ).rejects.toThrow(DraftCreationOutcomeUnknownError);
    expect(starts).toBe(0);
  });

  it("does not treat a replay of the last failure as proof that its retry failed", async () => {
    const creations = creationsFor(storage());
    const submit = () =>
      creations.submit({
        ...scope,
        kind: "agent",
        request,
        send: async ({ idempotencyKey, onEvent }) => {
          onEvent(failure({ kind: "agent", idempotencyKey, unknown: false }));
          throw new Error("Response lost");
        },
      });
    await expect(submit()).rejects.toThrow("Response lost");
    await expect(submit()).rejects.toThrow("Response lost");
    let starts = 0;
    await expect(
      creations.submit({
        ...scope,
        kind: "agent",
        request: { ...request, initialPrompt: "Edited during retry" },
        send: async () => {
          starts++;
        },
      }),
    ).rejects.toThrow(DraftCreationOutcomeUnknownError);
    expect(starts).toBe(0);
  });
});

const handedOffWorkspace = WorkspaceDescriptorPayloadSchema.parse({
  id: "workspace-1",
  projectId: "project",
  projectDisplayName: "Project",
  projectRootPath: "/repo",
  workspaceDirectory: "/repo/worktree",
  projectKind: "git",
  workspaceKind: "worktree",
  name: "Ready workspace",
  status: "running",
  statusEnteredAt: null,
  activityAt: null,
  archivingAt: null,
  scripts: [],
});
const handedOffRequest = { source: { kind: "directory", path: "/repo" }, agent: request };
const destinationRequest = { ...request, config: { ...request.config, cwd: "/repo/worktree" } };
const recoveredAgent = {
  id: "agent-1",
  workspaceId: "workspace-1",
  provider: "codex",
  cwd: "/repo/worktree",
  model: null,
  createdAt: "2026-11-20T00:00:00Z",
  updatedAt: "2026-11-20T00:00:00Z",
  lastUserMessageAt: null,
  status: "idle",
  capabilities: {
    supportsStreaming: true,
    supportsSessionPersistence: true,
    supportsDynamicModes: false,
    supportsMcpServers: false,
    supportsReasoningStream: false,
    supportsToolInvocations: true,
    supportsRewindConversation: false,
    supportsRewindFiles: false,
    supportsRewindBoth: false,
  },
  currentModeId: null,
  availableModes: [],
  pendingPermissions: [],
  persistence: null,
  title: "Original",
  labels: {},
} satisfies import("@getpaseo/protocol/messages").AgentSnapshotPayload;

function deferredValue<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function seedWorkspaceAttempt(disk: ReturnType<typeof storage>, initialAgent = true) {
  await creationsFor(disk).submit({
    ...scope,
    kind: "workspace",
    request: initialAgent ? handedOffRequest : { source: handedOffRequest.source },
    send: async ({ idempotencyKey, onEvent }) => {
      onEvent({
        ...failure({ kind: "workspace", idempotencyKey, unknown: false }),
        phase: "workspace_ready",
        revision: 1,
        error: null,
        workspace: handedOffWorkspace,
      });
    },
  });
}

describe("creation receipt reconciliation and retirement", () => {
  it("checkpoints conclusive result receipts even when repeated legacy revisions do not advance", async () => {
    const disk = storage();
    const input = { source: handedOffRequest.source };
    for (const _attempt of [1, 2]) {
      await creationsFor(disk).submit({
        ...scope,
        kind: "workspace",
        request: input,
        send: async ({ idempotencyKey }) => ({
          error: "Unknown branch",
          creation: failure({ kind: "workspace", idempotencyKey, unknown: false }),
        }),
      });
    }
    expect(
      await creationsFor(disk).submit({
        ...scope,
        kind: "workspace",
        request: { source: { ...input.source, path: "/valid" } },
        send: async () => "corrected",
      }),
    ).toBe("corrected");
  });

  it("recovers the original completed agent after handoff and reload without creating another", async () => {
    const disk = storage();
    await seedWorkspaceAttempt(disk);
    const restored = creationsFor(disk);
    const agent = await restored.reconcileWorkspace({
      ...scope,
      workspaceId: "workspace-1",
      request: destinationRequest,
      observe: async (kind, key, onEvent) => {
        expect([kind, key]).toEqual([
          "workspace",
          draftCreationKey(scope.draftId, handedOffRequest),
        ]);
        const snapshot = {
          ...failure({ kind, idempotencyKey: key, unknown: false }),
          phase: "completed" as const,
          error: null,
          workspace: handedOffWorkspace,
          agent: recoveredAgent,
        };
        onEvent(snapshot);
        return snapshot;
      },
    });
    expect(agent).toEqual(recoveredAgent);
  });

  it("learns a definite workspace startup failure before admitting an edited standalone agent", async () => {
    const disk = storage();
    await seedWorkspaceAttempt(disk);
    const restored = creationsFor(disk);
    expect(
      await restored.reconcileWorkspace({
        ...scope,
        workspaceId: "workspace-1",
        request: destinationRequest,
        observe: async (kind, key, onEvent) => {
          const snapshot = {
            ...failure({ kind, idempotencyKey: key, unknown: false }),
            revision: 1,
          };
          onEvent(snapshot);
          return snapshot;
        },
      }),
    ).toBeUndefined();
    expect(
      await creationsFor(disk).submit({
        ...scope,
        kind: "agent",
        request: { ...destinationRequest, initialPrompt: "Edited task" },
        send: async () => "edited-agent",
      }),
    ).toBe("edited-agent");
  });

  it("keeps unknown receipts and edited completed requests protected", async () => {
    const disk = storage();
    await seedWorkspaceAttempt(disk);
    const restored = creationsFor(disk);
    await expect(
      restored.reconcileWorkspace({
        ...scope,
        workspaceId: "workspace-1",
        request: destinationRequest,
        observe: async () => null,
      }),
    ).rejects.toThrow(DraftCreationOutcomeUnknownError);
    await expect(
      restored.reconcileWorkspace({
        ...scope,
        workspaceId: "workspace-1",
        request: { ...destinationRequest, initialPrompt: "Changed" },
        observe: async (kind, key, onEvent) => {
          const snapshot = {
            ...failure({ kind, idempotencyKey: key, unknown: false }),
            phase: "completed" as const,
            error: null,
            workspace: handedOffWorkspace,
            agent: recoveredAgent,
          };
          onEvent(snapshot);
          return snapshot;
        },
      }),
    ).rejects.toThrow(DraftCreationOutcomeUnknownError);
  });

  it.each(["workspace", "agent"] as const)(
    "retires a reused workspace after a conclusive %s Chat startup failure and reload",
    async (kind) => {
      const disk = storage();
      if (kind === "agent") await seedWorkspaceAttempt(disk, false);
      await creationsFor(disk).submit({
        ...scope,
        kind,
        request: kind === "workspace" ? handedOffRequest : destinationRequest,
        send: async ({ idempotencyKey }) => ({
          creation: {
            ...failure({ kind, idempotencyKey, unknown: false }),
            workspace: handedOffWorkspace,
          },
        }),
      });
      const restored = creationsFor(disk);
      expect(
        await restored.workspaceRetry({ ...scope, request: { source: handedOffRequest.source } }),
      ).toEqual({ kind: "reuse", workspace: handedOffWorkspace });
      let retirements = 0;
      const retirement = {
        ...scope,
        workspaceId: handedOffWorkspace.id,
        retire: () => {
          retirements += 1;
        },
      };
      expect(
        await restored.retireWorkspace({ ...retirement, workspaceId: "unrelated-workspace" }),
      ).toBe(false);
      expect(await restored.retireWorkspace(retirement)).toBe(true);
      expect(retirements).toBe(1);
    },
  );

  it.each(["pending", "unknown", "completed"] as const)(
    "does not retire a workspace whose Chat attempt is %s",
    async (outcome) => {
      const disk = storage();
      const phases = {
        pending: "workspace_ready",
        unknown: "failed",
        completed: "completed",
      } as const;
      await creationsFor(disk).submit({
        ...scope,
        kind: "workspace",
        request: handedOffRequest,
        send: async ({ idempotencyKey }) => ({
          creation: {
            ...failure({ kind: "workspace", idempotencyKey, unknown: outcome === "unknown" }),
            phase: phases[outcome],
            workspace: handedOffWorkspace,
            ...(outcome === "completed" ? { agent: recoveredAgent } : {}),
          },
        }),
      });
      let retirements = 0;
      expect(
        await creationsFor(disk).retireWorkspace({
          ...scope,
          workspaceId: handedOffWorkspace.id,
          retire: () => {
            retirements += 1;
          },
        }),
      ).toBe(false);
      expect(retirements).toBe(0);
    },
  );

  it.each([false, true])(
    "rechecks retirement during a newer agent admission after failed Chat=%s, without waiting for its network result",
    async (failedChat) => {
      const disk = storage();
      if (failedChat) {
        await creationsFor(disk).submit({
          ...scope,
          kind: "workspace",
          request: handedOffRequest,
          send: async ({ idempotencyKey }) => ({
            creation: {
              ...failure({ kind: "workspace", idempotencyKey, unknown: false }),
              workspace: handedOffWorkspace,
            },
          }),
        });
      } else {
        await seedWorkspaceAttempt(disk, false);
      }
      const writing = deferredValue<void>();
      const persist = deferredValue<void>();
      const network = deferredValue<string>();
      const creations = creationsFor({
        getItem: disk.getItem,
        setItem: async (key, value) => {
          if ((JSON.parse(value) as { attempt?: { kind: string } }).attempt?.kind === "agent") {
            writing.resolve();
            await persist.promise;
          }
          await disk.setItem(key, value);
        },
      });
      const retire = {
        ...scope,
        workspaceId: "workspace-1",
        retire: () => {
          retirements++;
        },
      };
      let retirements = 0;
      expect(await creations.retireWorkspace(retire)).toBe(true);
      const pending = creations.submit({
        ...scope,
        kind: "agent",
        request: destinationRequest,
        send: async () => network.promise,
      });
      await writing.promise;
      const delayedRetirement = creations.retireWorkspace(retire);
      persist.resolve();
      expect(await delayedRetirement).toBe(false);
      expect(retirements).toBe(1);
      network.resolve("original-agent");
      expect(await pending).toBe("original-agent");
    },
  );
});

it("agent admission reclaims an identity retired before it acquired the lock", async () => {
  const disk = storage();
  await seedWorkspaceAttempt(disk, false);
  const creations = creationsFor(disk);
  let owner: string | undefined = scope.draftId;
  expect(
    await creations.retireWorkspace({
      ...scope,
      workspaceId: "workspace-1",
      retire: () => {
        owner = undefined;
      },
    }),
  ).toBe(true);
  expect(
    await creations.submit({
      ...scope,
      kind: "agent",
      request: destinationRequest,
      onAdmitted: async () => {
        owner = scope.draftId;
      },
      send: async () => {
        expect(owner).toBe(scope.draftId);
        return "claimed-agent";
      },
    }),
  ).toBe("claimed-agent");
});

it("coalesces identical overlapping controller submissions through the legacy SDK into one provisioning call", async () => {
  const disk = storage();
  const creations = creationsFor(disk);
  const release = deferredValue<void>();
  const started = deferredValue<void>();
  let provisions = 0;
  const sdk = new CreationClient({
    supports: () => false,
    requestId: () => "request-id",
    request: async () => {
      throw new Error("Modern creation must not run");
    },
    observe: () => () => {},
    legacyAgent: async () => {
      throw new Error("Empty creation must not start an agent");
    },
    legacyWorkspace: async () => {
      provisions += 1;
      const workspace = { ...handedOffWorkspace, id: `workspace-${provisions}` };
      started.resolve();
      await release.promise;
      return { requestId: "legacy", workspace, error: null, setupTerminalId: null };
    },
  });
  const input = { source: { kind: "directory" as const, path: "/repo" } };
  expect(
    await Promise.all([
      creations.workspaceRetry({ ...scope, request: input }),
      creations.workspaceRetry({ ...scope, request: input }),
    ]),
  ).toEqual([{ kind: "create" }, { kind: "create" }]);
  const firstEvents: CreationSnapshot[] = [];
  const secondEvents: CreationSnapshot[] = [];
  const send = (options: {
    idempotencyKey: string;
    onEvent: (snapshot: CreationSnapshot) => void;
  }) => sdk.createWorkspace({ ...input, ...options });
  const first = creations.submit({
    ...scope,
    kind: "workspace",
    request: input,
    send,
    onEvent: (snapshot) => {
      firstEvents.push(snapshot);
    },
  });
  const second = creations.submit({
    ...scope,
    kind: "workspace",
    request: { source: { path: "/repo", kind: "directory" } },
    send,
    onEvent: (snapshot) => {
      secondEvents.push(snapshot);
    },
  });
  await started.promise;
  release.resolve();
  const results = await Promise.all([first, second]);
  expect(provisions).toBe(1);
  expect(results.map((result) => result.workspace?.id)).toEqual(["workspace-1", "workspace-1"]);
  expect(firstEvents.map((snapshot) => snapshot.phase)).toEqual(["workspace_ready"]);
  expect(secondEvents).toEqual(firstEvents);
});

it("releases a coalesced failed submission so the unchanged draft can retry", async () => {
  const creations = creationsFor(storage());
  const started = deferredValue<void>();
  let reject!: (error: Error) => void;
  const network = new Promise<string>((_resolve, fail) => {
    reject = fail;
  });
  let sends = 0;
  const send = async () => {
    sends += 1;
    started.resolve();
    return network;
  };
  const first = creations.submit({ ...scope, kind: "agent", request, send });
  const second = creations.submit({ ...scope, kind: "agent", request, send });
  const joined = Promise.allSettled([first, second]);
  await started.promise;
  const rejection = new NotSentError("Local validation rejected this frame");
  reject(rejection);
  expect(await joined).toEqual([
    { status: "rejected", reason: rejection },
    { status: "rejected", reason: rejection },
  ]);
  expect(
    await creations.submit({
      ...scope,
      kind: "agent",
      request,
      send: async () => {
        sends += 1;
        return "retried";
      },
    }),
  ).toBe("retried");
  expect(sends).toBe(2);
});

it("replays current progress to a caller joining an in-flight creation", async () => {
  const creations = creationsFor(storage());
  const published = deferredValue<void>();
  const network = deferredValue<string>();
  const snapshot = {
    ...failure({
      kind: "workspace",
      idempotencyKey: draftCreationKey(scope.draftId, handedOffRequest),
      unknown: false,
    }),
    phase: "workspace_ready" as const,
    error: null,
    workspace: handedOffWorkspace,
  };
  const first = creations.submit({
    ...scope,
    kind: "workspace",
    request: handedOffRequest,
    onEvent: () => {
      throw new Error("Unmounted progress consumer");
    },
    send: async ({ onEvent }) => {
      onEvent(snapshot);
      published.resolve();
      return network.promise;
    },
  });
  await published.promise;
  const joinedProgress = deferredValue<CreationSnapshot>();
  let duplicateSends = 0;
  const second = creations.submit({
    ...scope,
    kind: "workspace",
    request: handedOffRequest,
    onEvent: joinedProgress.resolve,
    send: async () => {
      duplicateSends += 1;
      return "duplicate";
    },
  });
  expect(await joinedProgress.promise).toEqual(snapshot);
  network.resolve("original");
  expect(await Promise.all([first, second])).toEqual(["original", "original"]);
  expect(duplicateSends).toBe(0);
});

it("reads a retained worktree slug during provisioning so overlapping submissions can coalesce", async () => {
  const creations = creationsFor(storage());
  expect(await creations.worktreeSlug({ ...scope, proposed: "retained-slug" })).toBe(
    "retained-slug",
  );
  const started = deferredValue<void>();
  const network = deferredValue<string>();
  let sends = 0;
  const send = async () => {
    sends += 1;
    started.resolve();
    return network.promise;
  };
  const first = creations.submit({ ...scope, kind: "workspace", request: worktreeRequest, send });
  await started.promise;
  const retained = await creations.worktreeSlug({ ...scope, proposed: "must-not-replace" });
  expect(retained).toBe("retained-slug");
  const second = creations.submit({ ...scope, kind: "workspace", request: worktreeRequest, send });
  network.resolve("one-worktree");
  expect(await Promise.all([first, second])).toEqual(["one-worktree", "one-worktree"]);
  expect(sends).toBe(1);
});

it("observes a pending standalone agent receipt after reload before admitting an edited retry", async () => {
  const disk = storage();
  await creationsFor(disk).submit({
    ...scope,
    kind: "agent",
    request,
    send: async () => undefined,
  });
  const restored = creationsFor(disk);
  const edited = { ...request, initialPrompt: "Corrected standalone task" };
  const observations: string[] = [];
  expect(
    await restored.reconcileWorkspace({
      ...scope,
      workspaceId: request.workspaceId,
      request: edited,
      observe: async (kind, key, onEvent) => {
        observations.push(kind, key);
        const receipt = failure({ kind, idempotencyKey: key, unknown: false });
        onEvent(receipt);
        return receipt;
      },
    }),
  ).toBeUndefined();
  expect(observations).toEqual(["agent", draftCreationKey(scope.draftId, request)]);
  expect(
    await restored.submit({
      ...scope,
      kind: "agent",
      request: edited,
      send: async () => "corrected-agent",
    }),
  ).toBe("corrected-agent");
});

it("replays unchanged standalone intent with its stable key without requiring lifecycle observation", async () => {
  const disk = storage();
  await creationsFor(disk).submit({
    ...scope,
    kind: "agent",
    request,
    send: async () => undefined,
  });
  const restored = creationsFor(disk);
  expect(
    await restored.reconcileWorkspace({
      ...scope,
      workspaceId: request.workspaceId,
      request,
      observe: async () => {
        throw new Error("Unchanged retries use the original creation key");
      },
    }),
  ).toBeUndefined();
  expect(
    await restored.submit({
      ...scope,
      kind: "agent",
      request,
      send: async ({ idempotencyKey }) => {
        expect(idempotencyKey).toBe(draftCreationKey(scope.draftId, request));
        return recoveredAgent;
      },
    }),
  ).toEqual(recoveredAgent);
});

it.each(["unknown", "completed", "missing"] as const)(
  "keeps an edited standalone agent protected when its saved receipt is %s",
  async (outcome) => {
    const disk = storage();
    await creationsFor(disk).submit({
      ...scope,
      kind: "agent",
      request,
      send: async () => undefined,
    });
    await expect(
      creationsFor(disk).reconcileWorkspace({
        ...scope,
        workspaceId: request.workspaceId,
        request: { ...request, initialPrompt: "Changed intent" },
        observe: async (kind, key, onEvent) => {
          if (outcome === "missing") return null;
          const receipt = {
            ...failure({ kind, idempotencyKey: key, unknown: outcome === "unknown" }),
            phase: outcome === "unknown" ? ("failed" as const) : ("completed" as const),
            ...(outcome === "completed" ? { agent: recoveredAgent } : {}),
          };
          onEvent(receipt);
          return receipt;
        },
      }),
    ).rejects.toThrow(DraftCreationOutcomeUnknownError);
  },
);

it("recovers a host workspace receipt before routing an edited retry without a local ready milestone", async () => {
  const disk = storage();
  await creationsFor(disk).submit({
    ...scope,
    kind: "workspace",
    request: handedOffRequest,
    send: async () => undefined,
  });
  const restored = creationsFor(disk);
  const edited = {
    ...handedOffRequest,
    agent: { ...request, initialPrompt: "Corrected after early reload" },
  };
  const observed: string[] = [];
  expect(
    await restored.workspaceRetry({
      ...scope,
      request: edited,
      observe: async (kind, key, onEvent) => {
        observed.push(kind, key);
        const receipt = {
          ...failure({ kind, idempotencyKey: key, unknown: false }),
          workspace: handedOffWorkspace,
        };
        onEvent(receipt);
        return receipt;
      },
    }),
  ).toEqual({ kind: "reuse", workspace: handedOffWorkspace });
  expect(observed).toEqual(["workspace", draftCreationKey(scope.draftId, handedOffRequest)]);
  expect(
    await restored.submit({
      ...scope,
      kind: "agent",
      request: { ...destinationRequest, initialPrompt: "Corrected after early reload" },
      send: async () => "corrected-agent",
    }),
  ).toBe("corrected-agent");
});

it.each(["missing", "unknown"] as const)(
  "keeps an edited workspace retry protected without a ready milestone when its receipt is %s",
  async (outcome) => {
    const disk = storage();
    await creationsFor(disk).submit({
      ...scope,
      kind: "workspace",
      request: handedOffRequest,
      send: async () => undefined,
    });
    const restored = creationsFor(disk);
    const edited = {
      ...handedOffRequest,
      agent: { ...request, initialPrompt: "Edited before ready" },
    };
    const retry = restored.workspaceRetry({
      ...scope,
      request: edited,
      observe: async (kind, key, onEvent) => {
        if (outcome === "missing") return null;
        const receipt = failure({ kind, idempotencyKey: key, unknown: true });
        onEvent(receipt);
        return receipt;
      },
    });
    await expect(retry).rejects.toThrow(DraftCreationOutcomeUnknownError);
    let sends = 0;
    await expect(
      restored.submit({
        ...scope,
        kind: "workspace",
        request: edited,
        send: async () => {
          sends += 1;
        },
      }),
    ).rejects.toThrow(DraftCreationOutcomeUnknownError);
    expect(sends).toBe(0);
  },
);

it.each(["workspace", "agent"] as const)(
  "reconciles a cached workspace's pending %s before switching to Terminal",
  async (priorKind) => {
    const disk = storage();
    await seedWorkspaceAttempt(disk, priorKind === "workspace");
    if (priorKind === "agent") {
      await creationsFor(disk).submit({
        ...scope,
        kind: "agent",
        request: destinationRequest,
        send: async () => undefined,
      });
    }
    const restored = creationsFor(disk);
    const terminalRequest = { source: handedOffRequest.source, launchTarget: { kind: "terminal" } };
    const observed: string[] = [];
    expect(
      await restored.workspaceRetry({
        ...scope,
        request: terminalRequest,
        observe: async (kind, key, onEvent) => {
          observed.push(kind, key);
          const receipt = failure({ kind, idempotencyKey: key, unknown: false });
          onEvent(receipt);
          return receipt;
        },
      }),
    ).toEqual({ kind: "reuse", workspace: handedOffWorkspace });
    expect(observed).toEqual([
      priorKind,
      draftCreationKey(
        scope.draftId,
        priorKind === "workspace" ? handedOffRequest : destinationRequest,
      ),
    ]);
    let retired = false;
    expect(
      await restored.retireWorkspace({
        ...scope,
        workspaceId: handedOffWorkspace.id,
        retire: () => {
          retired = true;
        },
      }),
    ).toBe(true);
    expect(retired).toBe(true);
    expect(await creationsFor(disk).workspaceRetry({ ...scope, request: terminalRequest })).toEqual(
      {
        kind: "reuse",
        workspace: handedOffWorkspace,
      },
    );
  },
);

it.each([
  { priorKind: "workspace", outcome: "missing" },
  { priorKind: "workspace", outcome: "unknown" },
  { priorKind: "agent", outcome: "missing" },
  { priorKind: "agent", outcome: "unknown" },
] as const)(
  "keeps workspace-only retries protected with cached readiness when the $priorKind receipt is $outcome",
  async ({ priorKind, outcome }) => {
    const disk = storage();
    await seedWorkspaceAttempt(disk, priorKind === "workspace");
    if (priorKind === "agent") {
      await creationsFor(disk).submit({
        ...scope,
        kind: "agent",
        request: destinationRequest,
        send: async () => undefined,
      });
    }
    const restored = creationsFor(disk);
    let observations = 0;
    await expect(
      restored.workspaceRetry({
        ...scope,
        request: { source: handedOffRequest.source },
        observe: async (kind, key, onEvent) => {
          observations += 1;
          if (outcome === "missing") return null;
          const receipt = failure({ kind, idempotencyKey: key, unknown: true });
          onEvent(receipt);
          return receipt;
        },
      }),
    ).rejects.toThrow(DraftCreationOutcomeUnknownError);
    expect(observations).toBe(1);
    let retirements = 0;
    expect(
      await restored.retireWorkspace({
        ...scope,
        workspaceId: handedOffWorkspace.id,
        retire: () => {
          retirements += 1;
        },
      }),
    ).toBe(false);
    expect(retirements).toBe(0);
  },
);

it.each(["failed", "completed"] as const)(
  "recovers a handed-off workspace's %s receipt when its ready checkpoint was lost",
  async (phase) => {
    const disk = storage();
    await creationsFor(disk).submit({
      ...scope,
      kind: "workspace",
      request: handedOffRequest,
      send: async () => undefined,
    });
    let observations = 0;
    const restored = creationsFor(disk);
    const result = await restored.reconcileWorkspace({
      ...scope,
      workspaceId: handedOffWorkspace.id,
      request: destinationRequest,
      observe: async (kind, key, onEvent) => {
        observations += 1;
        const receipt = {
          ...failure({ kind, idempotencyKey: key, unknown: false }),
          phase,
          workspace: handedOffWorkspace,
          ...(phase === "completed" ? { agent: recoveredAgent, error: null } : {}),
        };
        onEvent(receipt);
        return receipt;
      },
    });
    expect(observations).toBe(1);
    expect(result).toEqual(phase === "completed" ? recoveredAgent : undefined);
  },
);

it.each(["missing", "different"] as const)(
  "refuses handed-off recovery when the observed workspace is %s",
  async (ready) => {
    const disk = storage();
    await creationsFor(disk).submit({
      ...scope,
      kind: "workspace",
      request: handedOffRequest,
      send: async () => undefined,
    });
    let observations = 0;
    await expect(
      creationsFor(disk).reconcileWorkspace({
        ...scope,
        workspaceId: handedOffWorkspace.id,
        request: destinationRequest,
        observe: async (kind, key, onEvent) => {
          observations += 1;
          const receipt = {
            ...failure({ kind, idempotencyKey: key, unknown: false }),
            ...(ready === "different"
              ? { workspace: { ...handedOffWorkspace, id: "another-workspace" } }
              : {}),
          };
          onEvent(receipt);
          return receipt;
        },
      }),
    ).rejects.toThrow(DraftCreationOutcomeUnknownError);
    expect(observations).toBe(1);
  },
);
