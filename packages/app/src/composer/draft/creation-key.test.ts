import { describe, expect, it } from "vitest";
import { draftCreationKey } from "./creation-key";
import { createDraftCreations, DraftCreationOutcomeUnknownError } from "./creation-attempt";
import type { CreationSnapshot } from "@getpaseo/protocol/messages";

const request = {
  config: { provider: "codex", cwd: "/repo", model: "gpt-6" },
  workspaceId: "workspace-1",
  initialPrompt: "Start the original task.",
  clientMessageId: "draft-1:initial-message",
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
});

function creationsFor(disk: Parameters<typeof createDraftCreations>[0]) {
  return createDraftCreations(disk, () => "Check the previous start before creating another.");
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
      request,
      send: async () => {
        starts++;
        return "started";
      },
    });
    expect(retried).toBe("started");
    expect(starts).toBe(1);
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
