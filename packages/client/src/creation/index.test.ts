import { expect, test } from "vitest";
import type {
  AgentSnapshotPayload,
  CreationSnapshot,
  WorkspaceDescriptorPayload,
} from "@getpaseo/protocol/messages";
import { CreationClient, type CreationResult } from "./index.js";

const workspace: WorkspaceDescriptorPayload = {
  id: "wks_0123456789abcdef",
  projectId: "project",
  projectDisplayName: "Project",
  projectRootPath: "/project",
  workspaceDirectory: "/project/worktree",
  projectKind: "git",
  workspaceKind: "worktree",
  name: "Worktree",
  status: "running",
  statusEnteredAt: null,
  activityAt: null,
  archivingAt: null,
  scripts: [],
};
const agent: AgentSnapshotPayload = {
  id: "00000000-0000-4000-8000-000000000001",
  workspaceId: workspace.id,
  provider: "codex",
  cwd: "/project/worktree",
  model: null,
  createdAt: "2026-09-11T00:00:00Z",
  updatedAt: "2026-09-11T00:00:00Z",
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
  title: "Start once",
  labels: {},
};

function fixture(modern: boolean) {
  const requests: Array<{ kind: string; input: Record<string, unknown> }> = [];
  const legacy: Array<{ kind: string; input: unknown }> = [];
  let resolve!: (result: CreationResult) => void;
  const result = new Promise<CreationResult>((done) => {
    resolve = done;
  });
  const client = new CreationClient({
    supports: () => modern,
    connected: () => true,
    requestId: () => "generated-key",
    request: async (kind, input) => {
      requests.push({ kind, input });
      return result;
    },
    subscribe: async () => null,
    legacyWorkspace: async (input) => {
      legacy.push({ kind: "workspace", input });
      return { requestId: "legacy-workspace", workspace, error: null, setupTerminalId: null };
    },
    legacyAgent: async (input) => {
      legacy.push({ kind: "agent", input });
      return agent;
    },
    sendMessage: async (id, text, options) => {
      legacy.push({ kind: "message", input: { id, text, ...options } });
    },
  });
  const input = {
    idempotencyKey: "intent-one",
    source: { kind: "directory" as const, path: "/project" },
    agent: {
      config: { provider: "codex", cwd: "/project" },
      initialPrompt: "Start once",
      clientMessageId: "message-one",
    },
  };
  return { client, requests, legacy, resolve, input };
}

test("duplicate client submissions join one complete intent and cumulative updates never regress", async () => {
  const f = fixture(true);
  const phases: string[] = [];
  const first = f.client.createWorkspace({
    ...f.input,
    onEvent: (snapshot) => phases.push(snapshot.phase),
  });
  const duplicate = f.client.createWorkspace(f.input);
  expect(duplicate).toBe(first);
  expect(f.requests).toEqual([{ kind: "workspace", input: { ...f.input, subscribe: true } }]);
  await expect(
    f.client.createWorkspace({
      ...f.input,
      agent: { ...f.input.agent, initialPrompt: "Different intent" },
    }),
  ).rejects.toThrow("workspace_request_key_conflict");
  const snapshot: CreationSnapshot = {
    kind: "workspace",
    idempotencyKey: "intent-one",
    revision: 2,
    phase: "workspace_ready",
    workspaceId: workspace.id,
    agentId: agent.id,
    workspace,
    error: null,
  };
  f.client.receive(snapshot);
  f.client.receive({ ...snapshot, revision: 1, phase: "accepted" });
  expect(phases).toEqual(["workspace_ready"]);
  const late: string[] = [];
  f.client.createWorkspace({ ...f.input, onEvent: (update) => late.push(update.phase) });
  expect(late).toEqual(["workspace_ready"]);
  f.resolve({
    workspace,
    agent,
    error: null,
    setupSkippedReason: "Untrusted source",
    requestId: "response-one",
  });
  expect(await first).toMatchObject({
    workspace,
    agent,
    setupSkippedReason: "Untrusted source",
    requestId: "response-one",
  });
  expect(await duplicate).toEqual(await first);
  expect(f.legacy).toEqual([]);
  f.client.close();
});

test("legacy adaptation keeps workspace, agent and initial prompt sequencing inside the client", async () => {
  const f = fixture(false);
  const phases: string[] = [];
  const result = await f.client.createWorkspace({
    ...f.input,
    onEvent: (snapshot) => phases.push(snapshot.phase),
  });
  expect(result).toMatchObject({ workspace, agent, error: null });
  expect(phases).toEqual(["workspace_ready"]);
  expect(f.legacy).toEqual([
    { kind: "workspace", input: { idempotencyKey: "intent-one", source: f.input.source } },
    {
      kind: "agent",
      input: {
        config: { provider: "codex", cwd: workspace.workspaceDirectory },
        workspaceId: workspace.id,
        idempotencyKey: "intent-one:agent",
        clientMessageId: "message-one",
      },
    },
    {
      kind: "message",
      input: {
        id: agent.id,
        text: "Start once",
        messageId: "message-one",
        images: undefined,
        attachments: undefined,
      },
    },
  ]);
  expect(f.requests).toEqual([]);
  f.client.close();
});

test("legacy daemons cannot silently replace caller-selected IDs", async () => {
  const f = fixture(false);
  await expect(f.client.createWorkspace({ ...f.input, workspaceId: workspace.id })).rejects.toThrow(
    "caller-selected",
  );
  await expect(
    f.client.createAgent({ agentId: agent.id, config: f.input.agent.config }),
  ).rejects.toThrow("caller-selected");
  expect(f.legacy).toEqual([]);
  f.client.close();
});

test("keyed creation with an empty prompt works on legacy daemons without sending an empty message", async () => {
  const f = fixture(false);
  await f.client.createAgent({
    idempotencyKey: "empty-agent",
    config: f.input.agent.config,
    initialPrompt: "",
  });
  expect(f.legacy).toEqual([
    { kind: "agent", input: { idempotencyKey: "empty-agent", config: f.input.agent.config } },
  ]);
  f.client.close();
});
