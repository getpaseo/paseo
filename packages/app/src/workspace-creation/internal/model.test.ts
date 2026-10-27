import { describe, expect, it } from "vitest";
import type { CreationSnapshot } from "@getpaseo/protocol/messages";
import { createWorkspaceCreationModel } from "../model";

describe("optimistic workspace creation", () => {
  it("publishes final identities and immutable input before preparing or receiving anything", async () => {
    let prepare!: () => void;
    const held = new Promise<void>((resolve) => {
      prepare = resolve;
    });
    const requests: unknown[] = [];
    const failures: string[] = [];
    const model = createWorkspaceCreationModel({
      identities: () => ({
        operationKey: "operation",
        workspaceId: "wks_0123456789abcdef",
        agentId: "agent",
        clientMessageId: "message",
      }),
      execute: async (request) => {
        requests.push(request);
        return { workspace: null, error: "test failure" };
      },
    });
    const input = {
      serverId: "host",
      key: "draft",
      provider: "codex" as const,
      config: {},
      projectId: "project",
      projectName: "Project",
      text: "My prompt",
      onWorkspaceFailed: (_attempt: unknown, error: string) => failures.push(error),
      prepare: async () => {
        await held;
        return {
          source: { kind: "directory" as const, path: "/project" },
          agent: {
            config: { provider: "codex" as const, cwd: "/project" },
            initialPrompt: "My prompt",
          },
        };
      },
    };
    const attempt = model.submit(input);
    expect(attempt.workspaceId).toBe("wks_0123456789abcdef");
    expect(model.getWorkspace("host", attempt.workspaceId)?.text).toBe("My prompt");
    expect(model.submit(input)).toBe(attempt);
    expect(requests).toEqual([]);
    prepare();
    await model.settled(attempt);
    expect(requests).toHaveLength(1);
    expect(failures).toEqual(["test failure"]);
    expect(model.getWorkspace("host", attempt.workspaceId)).toBeNull();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function submission() {
  return {
    serverId: "host",
    key: "draft-version-1",
    provider: "codex" as const,
    config: {},
    projectId: "project",
    projectName: "Project",
    text: "Original prompt",
    prepare: async () => ({
      source: { kind: "directory" as const, path: "/project" },
      agent: {
        config: {
          provider: "codex" as const,
          cwd: "/project/nested",
          featureValues: { option: true },
        },
        initialPrompt: "Original prompt",
        attachments: [
          {
            type: "text" as const,
            mimeType: "text/plain" as const,
            text: "Attachment content",
            title: "Context",
          },
        ],
      },
    }),
  };
}
function identities() {
  return {
    operationKey: "operation",
    workspaceId: "wks_0123456789abcdef",
    agentId: "agent",
    clientMessageId: "message",
  };
}

/** A host receipt; the workspace and agent payloads only need to be present. */
function failedCreation(update: object): CreationSnapshot {
  return {
    kind: "workspace",
    idempotencyKey: "operation",
    revision: 3,
    phase: "failed",
    workspaceId: identities().workspaceId,
    agentId: "agent",
    error: "Provider startup failed",
    ...update,
  } as CreationSnapshot;
}

describe("creation lifecycle ownership", () => {
  it.each([
    ["the transport closes before any receipt", { throws: "Client closed" }, "workspace"],
    [
      "provisioning fails",
      { creation: { failedStage: "workspace", outcomeUnknown: true } },
      "workspace",
    ],
    ["agent creation fails after provisioning", { creation: { failedStage: "agent" } }, "agent"],
    [
      "the transport closes after the workspace was published",
      { throws: "Client closed", event: { phase: "workspace_ready", workspace: {} } },
      "agent",
    ],
    [
      "the agent may exist",
      { creation: { failedStage: "agent", outcomeUnknown: true } },
      "complete",
    ],
    [
      "the first prompt fails on a created agent",
      { creation: { failedStage: "prompt", outcomeUnknown: true } },
      "complete",
    ],
  ] as const)("when %s, hands the creation to its %s owner", async (_name, outcome, owner) => {
    const handled: string[] = [];
    let executions = 0;
    const model = createWorkspaceCreationModel({
      identities,
      execute: async (request) => {
        executions++;
        if ("event" in outcome)
          request.onEvent?.(failedCreation({ ...outcome.event, revision: 1 }));
        if ("throws" in outcome) throw new Error(outcome.throws);
        return { error: "Provider startup failed", creation: failedCreation(outcome.creation) };
      },
      onFailed: () => handled.push("prompt rejected"),
    });
    const attempt = model.submit({
      ...submission(),
      onWorkspaceFailed: () => handled.push("workspace"),
      onAgentFailed: () => handled.push("agent"),
      onComplete: () => handled.push("complete"),
    });
    await model.settled(attempt);
    expect(handled).toEqual(owner === "complete" ? ["complete"] : ["prompt rejected", owner]);
    // A kept agent stays presented until the host publishes it; a failure leaves at once.
    expect(model.getWorkspace("host", attempt.workspaceId)?.phase ?? null).toBe(
      owner === "complete" ? "complete" : null,
    );
    expect(executions).toBe(1);
  });

  it("returns a preparation failure to New workspace without any host execution", async () => {
    let executions = 0;
    const failures: string[] = [];
    const model = createWorkspaceCreationModel({
      identities,
      execute: async () => {
        executions++;
        return {};
      },
    });
    const attempt = model.submit({
      ...submission(),
      prepare: async () => {
        throw new Error("Image unavailable");
      },
      onWorkspaceFailed: (_attempt, error) => failures.push(error),
    });
    await model.settled(attempt);
    expect(failures).toEqual(["Image unavailable"]);
    expect(executions).toBe(0);
  });

  it("reports completion and adoption once", async () => {
    const lifecycle: string[] = [];
    const model = createWorkspaceCreationModel({
      identities,
      execute: async () => ({}),
      onSubmitted: (attempt) => lifecycle.push(`submitted:${attempt.phase}`),
      onComplete: (attempt) => lifecycle.push(`complete:${attempt.phase}`),
      onAdopted: (attempt) => lifecycle.push(`adopted:${attempt.phase}`),
    });
    const attempt = model.submit(submission());
    await model.settled(attempt);
    model.observeResources("host", new Set([attempt.workspaceId]), new Set());
    expect(lifecycle).toEqual(["submitted:preparing", "complete:complete"]);
    model.observeResources("host", new Set([attempt.workspaceId]), new Set([attempt.agentId]));
    model.observeResources("host", new Set([attempt.workspaceId]), new Set([attempt.agentId]));
    expect(lifecycle).toEqual(["submitted:preparing", "complete:complete", "adopted:complete"]);
  });

  it("keeps presentation stable across receipt updates and empty directory snapshots", async () => {
    const response = deferred<{}>();
    const observed =
      deferred<
        NonNullable<
          Parameters<Parameters<typeof createWorkspaceCreationModel>[0]["execute"]>[0]["onEvent"]
        >
      >();
    const model = createWorkspaceCreationModel({
      identities,
      execute: async (request) => {
        observed.resolve(request.onEvent!);
        return response.promise;
      },
    });
    const attempt = model.submit(submission());
    const onEvent = await observed.promise;
    const event = {
      kind: "workspace" as const,
      idempotencyKey: "operation",
      workspaceId: attempt.workspaceId,
      agentId: attempt.agentId,
      revision: 3,
      phase: "workspace_ready" as const,
      error: null,
    };
    const pendingSnapshot = model.getSnapshot();
    let publications = 0;
    const stop = model.subscribe(() => publications++);
    onEvent({ ...event, revision: 1, phase: "accepted" });
    onEvent(event);
    expect(model.getSnapshot()).toBe(pendingSnapshot);
    expect(publications).toBe(0);
    stop();
    model.observeResources("host", new Set(), new Set());
    expect(model.getWorkspace("host", attempt.workspaceId)).toMatchObject({
      workspaceObserved: false,
      agentObserved: false,
    });
    model.observeResources("host", new Set([attempt.workspaceId]), new Set([attempt.agentId]));
    model.observeResources("host", new Set(), new Set());
    response.resolve({});
    await model.settled(attempt);
    expect(model.getWorkspace("host", attempt.workspaceId)).toBeNull();
  });

  it("captures presentation without retaining caller mutation and permits a distinct newer intent", async () => {
    const response = deferred<{}>();
    let next = 0;
    const model = createWorkspaceCreationModel({
      identities: () => ({ ...identities(), agentId: `agent-${++next}` }),
      execute: async () => response.promise,
    });
    const original = submission();
    const first = model.submit(original);
    original.text = "Newer draft";
    const second = model.submit({ ...original, key: "draft-version-2" });
    expect(first.text).toBe("Original prompt");
    expect(second.text).toBe("Newer draft");
    expect(second.agentId).not.toBe(first.agentId);
    response.resolve({});
    await model.settled(first);
    await model.settled(second);
  });
});

describe("settled presentation lifetime", () => {
  it("retires adopted presentation while repeated submission still returns its original identities", async () => {
    let executions = 0;
    const model = createWorkspaceCreationModel({
      identities,
      execute: async () => {
        executions++;
        return {};
      },
    });
    const input = submission();
    const attempt = model.submit(input);
    await model.settled(attempt);
    model.observeResources("host", new Set([attempt.workspaceId]), new Set([attempt.agentId]));
    expect(model.getSnapshot()).toEqual([]);
    const repeated = model.submit(input);
    expect(repeated.workspaceId).toBe(attempt.workspaceId);
    expect(repeated.agentId).toBe(attempt.agentId);
    await model.settled(repeated);
    expect(executions).toBe(1);
    expect(repeated.text).toBe("");
    expect(repeated.message).toBeUndefined();
  });
});

it("bounds adopted receipts and keeps in-flight input outside that bound", async () => {
  let executions = 0;
  let identity = 0;
  const held = deferred<{}>();
  const model = createWorkspaceCreationModel({
    identities: () => ({
      ...identities(),
      workspaceId: `workspace-${++identity}`,
      agentId: `agent-${identity}`,
    }),
    execute: async (request) => {
      executions++;
      return request.agent?.initialPrompt === "held" ? held.promise : {};
    },
  });
  const pending = model.submit({
    ...submission(),
    key: "pending",
    prepare: async () => ({
      source: { kind: "directory", path: "/project" },
      agent: { provider: "codex", cwd: "/project", initialPrompt: "held" },
    }),
  });
  const first = { ...submission(), key: "settled-0" };
  let latest = first;
  for (let n = 0; n < 130; n++) {
    latest = { ...submission(), key: `settled-${n}` };
    const attempt = model.submit(latest);
    await model.settled(attempt);
    model.observeResources("host", new Set([attempt.workspaceId]), new Set([attempt.agentId]));
  }
  expect(model.getSnapshot()).toHaveLength(1);
  expect(model.getSnapshot()[0]?.text).toBe("Original prompt");
  const before = executions;
  await model.settled(model.submit(latest));
  expect(executions).toBe(before);
  await model.settled(model.submit(first));
  expect(executions).toBe(before + 1);
  held.resolve({});
  await model.settled(pending);
});
