import pino from "pino";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type {
  AgentSnapshotPayload,
  CreationSnapshot,
  UploadedImage,
  WorkspaceDescriptorPayload,
} from "@getpaseo/protocol/messages";
import { CreationService, fingerprintCreationIntent, type CreationInput } from "./index.js";

const silentLogger = pino({ level: "silent" });
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
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
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "creation-lifecycle-"));
  directories.push(directory);
  const service = new CreationService(directory, silentLogger);
  const provider = deferred();
  const ready = deferred();
  const calls: string[] = [];
  const input: CreationInput = {
    kind: "workspace",
    key: "submit-one",
    request: { source: "/project", prompt: "Start once" },
    workspaceId: workspace.id,
    agentId: agent.id,
    hasAgent: true,
    hasPrompt: true,
    exists: async () => false,
    provision: async () => {
      calls.push("workspace");
      return { workspace };
    },
    createAgent: async (_id, _workspace, onReady) => {
      await provider.promise;
      calls.push("agent");
      await onReady(agent);
      calls.push("prompt");
      return { agent, initialPromptStarted: true };
    },
  };
  const updates: CreationSnapshot[] = [];
  const observe = (snapshot: CreationSnapshot) => {
    updates.push(snapshot);
    if (snapshot.phase === "workspace_ready") ready.resolve();
  };
  return { directory, service, input, provider, ready, calls, updates, observe };
}

test("workspace readiness is observable before provider startup and duplicate requests join the same work", async () => {
  const f = await fixture();
  const first = f.service.create(f.input, f.observe);
  await f.ready.promise;
  expect(f.calls).toEqual(["workspace"]);
  expect(f.updates.map((s) => s.phase)).toEqual(["accepted", "workspace_ready"]);
  expect(f.updates[0]).toMatchObject({ workspaceId: workspace.id, agentId: agent.id });
  const duplicate = f.service.create(f.input);
  f.provider.resolve();
  expect(await first).toMatchObject({ phase: "completed", error: null, workspace, agent });
  expect(await duplicate).toEqual(await first);
  expect(f.calls).toEqual(["workspace", "agent", "prompt"]);
  expect(await new CreationService(f.directory, silentLogger).create(f.input)).toEqual(await first);
  expect(f.calls).toEqual(["workspace", "agent", "prompt"]);
});

test("a failed agent startup retries only that stage with the reserved IDs", async () => {
  const f = await fixture();
  let attempts = 0;
  f.input.createAgent = async (id, readyWorkspace, onReady) => {
    attempts++;
    expect(id).toBe(agent.id);
    expect(readyWorkspace).toEqual(workspace);
    if (attempts === 1) throw new Error("provider unavailable");
    await onReady(agent);
    return { agent, initialPromptStarted: true };
  };
  expect(await f.service.create(f.input)).toMatchObject({
    phase: "failed",
    failedStage: "agent",
    outcomeUnknown: false,
    workspace,
  });
  expect(await new CreationService(f.directory, silentLogger).create(f.input)).toMatchObject({
    phase: "completed",
    agent,
  });
  expect(f.calls).toEqual(["workspace"]);
  expect(attempts).toBe(2);
});

test("an uncertain prompt outcome never resends or removes its workspace and agent", async () => {
  const f = await fixture();
  let prompts = 0;
  f.input.createAgent = async (_id, _workspace, onReady) => {
    await onReady(agent);
    prompts++;
    throw new Error("connection lost after provider accepted prompt");
  };
  const result = await f.service.create(f.input);
  expect(result).toMatchObject({
    phase: "failed",
    failedStage: "prompt",
    outcomeUnknown: true,
    workspace,
    agent,
  });
  expect(await new CreationService(f.directory, silentLogger).create(f.input)).toEqual(result);
  expect(prompts).toBe(1);
});

test("conflicting intents and resource IDs cannot start more work", async () => {
  const f = await fixture();
  const first = f.service.create(f.input, f.observe);
  await f.ready.promise;
  await expect(f.service.create({ ...f.input, request: { prompt: "changed" } })).rejects.toThrow(
    "workspace_request_key_conflict",
  );
  await expect(f.service.create({ ...f.input, key: "another-intent" })).rejects.toThrow(
    "workspace_id_conflict",
  );
  f.provider.resolve();
  expect(await first).toMatchObject({ phase: "completed", error: null });
  expect(f.calls).toEqual(["workspace", "agent", "prompt"]);
});

test("late subscribers recover readiness and removing an observer cannot stop creation", async () => {
  const f = await fixture();
  const first = f.service.create(f.input, f.observe);
  await f.ready.promise;
  const updates: CreationSnapshot[] = [];
  const subscription = await f.service.subscribe("workspace", f.input.key, (snapshot) =>
    updates.push(snapshot),
  );
  expect(subscription.snapshot).toMatchObject({ phase: "workspace_ready", workspace });
  subscription.unsubscribe();
  f.provider.resolve();
  await first;
  expect(updates).toEqual([]);
  const completed = await new CreationService(f.directory, silentLogger).subscribe(
    "workspace",
    f.input.key,
    () => {},
  );
  expect(completed.snapshot).toMatchObject({ phase: "completed", agent, workspace });
  completed.unsubscribe();
});

test("omitted resource IDs are generated once and preserved on replay", async () => {
  const f = await fixture();
  f.input.workspaceId = undefined;
  f.input.agentId = undefined;
  f.input.provision = async (id) => ({ workspace: { ...workspace, id } });
  f.input.createAgent = async (id, createdWorkspace, onReady) => {
    const created = { ...agent, id, workspaceId: createdWorkspace!.id };
    await onReady(created);
    return { agent: created, initialPromptStarted: true };
  };
  const result = await f.service.create(f.input);
  expect(result.workspaceId).toMatch(/^wks_[a-f0-9]{16}$/);
  expect(result.agentId).toMatch(
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
  expect(await new CreationService(f.directory, silentLogger).create(f.input)).toEqual(result);
});

test("restart after a committed agent without a prompt completes without recreating the agent", async () => {
  const f = await fixture();
  const recoveredDirectory = await mkdtemp(join(tmpdir(), "creation-checkpoint-"));
  directories.push(recoveredDirectory);
  f.input.hasPrompt = false;
  let starts = 0;
  f.input.createAgent = async (_id, _workspace, onReady) => {
    starts++;
    await onReady(agent);
    // Capture the durable state at the exact milestone a process could stop after.
    await cp(f.directory, recoveredDirectory, { recursive: true });
    return { agent, initialPromptStarted: false };
  };
  await f.service.create(f.input);
  const recovered = await new CreationService(recoveredDirectory, silentLogger).create(f.input);
  expect(recovered).toMatchObject({ phase: "completed", workspace, agent });
  expect(starts).toBe(1);
});

test("partial provisioning without a registered workspace is not repeated", async () => {
  const f = await fixture();
  let provisions = 0;
  f.input.provision = async () => {
    provisions++;
    await writeFile(join(f.directory, "partial-checkout"), "disk was changed");
    throw new Error("Git failed after creating the checkout");
  };
  const result = await f.service.create(f.input);
  expect(result).toMatchObject({ phase: "failed", failedStage: "workspace", outcomeUnknown: true });
  expect(await new CreationService(f.directory, silentLogger).create(f.input)).toEqual(result);
  expect(provisions).toBe(1);
});

test.each(["pending", "completed"])(
  "imports a %s legacy agent receipt without creating another agent",
  async (state) => {
    const f = await fixture();
    const legacyDirectory = join(f.directory, "legacy");
    await mkdir(legacyDirectory);
    const request = { config: { cwd: "/project", provider: "codex" } };
    const hash = (value: unknown) =>
      createHash("sha256").update(JSON.stringify(value)).digest("hex");
    await writeFile(
      join(legacyDirectory, `${hash(["create", "old-key"])}.json`),
      JSON.stringify({
        fingerprint: hash({ ...request, type: "create_agent_request" }),
        state,
        agentId: agent.id,
      }),
    );
    const input: CreationInput = {
      kind: "agent",
      key: "old-key",
      request,
      hasAgent: true,
      hasPrompt: false,
      exists: async () => true,
      readAgent: async () => agent,
      createAgent: async () => {
        throw new Error("Must not create again");
      },
    };
    const service = new CreationService(f.directory, silentLogger, undefined, legacyDirectory);
    await expect(
      service.create({ ...input, request: { config: { ...request.config, cwd: "/changed" } } }),
    ).rejects.toThrow("agent_request_key_conflict");
    expect(await service.create(input)).toMatchObject({ phase: "completed", agent });
    expect(await new CreationService(f.directory, silentLogger).create(input)).toMatchObject({
      phase: "completed",
      agent,
    });
  },
);

test("observer failures are logged without failing creation", async () => {
  const f = await fixture();
  const logs: unknown[] = [];
  const logger = pino(
    { level: "warn" },
    {
      write: (line) => {
        logs.push(JSON.parse(line));
      },
    },
  );
  const service = new CreationService(f.directory, logger);
  f.provider.resolve();
  const result = await service.create(f.input, () => {
    throw new Error("delivery failed");
  });
  expect(result.phase).toBe("completed");
  expect(f.calls).toEqual(["workspace", "agent", "prompt"]);
  expect(logs).toContainEqual(
    expect.objectContaining({
      level: 40,
      kind: "workspace",
      idempotencyKey: f.input.key,
      phase: "workspace_ready",
      err: expect.objectContaining({ message: "delivery failed" }),
    }),
  );
});

test("reversed image order is a different creation intent", async () => {
  const paseoHome = await mkdtemp(join(tmpdir(), "creation-order-uploads-"));
  directories.push(paseoHome);
  const putUpload = async (id: string, bytes: Buffer): Promise<UploadedImage> => {
    const fileName = "image.png";
    await mkdir(join(paseoHome, "uploads", id), { recursive: true });
    await writeFile(join(paseoHome, "uploads", id, fileName), bytes);
    return { id, fileName, mimeType: "image/png", size: bytes.byteLength };
  };
  const firstUpload = await putUpload("upload_a1", Buffer.from("first image"));
  const secondUpload = await putUpload("upload_b1", Buffer.from("second image"));
  const firstRetry = await putUpload("upload_a2", Buffer.from("first image"));
  const secondRetry = await putUpload("upload_b2", Buffer.from("second image"));
  const directory = await mkdtemp(join(tmpdir(), "creation-order-intent-"));
  directories.push(directory);
  const service = new CreationService(directory, silentLogger);
  let starts = 0;
  const create = async (imageUploads: UploadedImage[]) => {
    const request = { config: { provider: "codex", cwd: "/project" }, imageUploads };
    return await service.create({
      kind: "agent",
      key: "image-order-key",
      request,
      fingerprint: await fingerprintCreationIntent(paseoHome, request),
      hasAgent: true,
      hasPrompt: true,
      exists: async () => false,
      readAgent: async () => agent,
      createAgent: async (id, _workspace, onReady) => {
        starts++;
        const created = { ...agent, id };
        await onReady(created);
        return { agent: created, initialPromptStarted: true };
      },
    });
  };

  const first = await create([firstUpload, secondUpload]);
  expect(await create([firstRetry, secondRetry])).toEqual(first);
  expect(starts).toBe(1);
  await expect(create([secondRetry, firstRetry])).rejects.toThrow("agent_request_key_conflict");
});

test("a retry that re-uploads the same images keeps the intent while different bytes conflict", async () => {
  const paseoHome = await mkdtemp(join(tmpdir(), "creation-uploads-"));
  directories.push(paseoHome);
  const putUpload = async (id: string, bytes: Buffer): Promise<UploadedImage> => {
    const fileName = "image.png";
    await mkdir(join(paseoHome, "uploads", id), { recursive: true });
    await writeFile(join(paseoHome, "uploads", id, fileName), bytes);
    return { id, fileName, mimeType: "image/png", size: bytes.byteLength };
  };
  const sameImage = Buffer.from("first image bytes");
  const firstUpload = await putUpload("upload_first", sameImage);
  const retryUpload = await putUpload("upload_retry", sameImage);
  const otherUpload = await putUpload("upload_other", Buffer.from("other image bytes"));
  const directory = await mkdtemp(join(tmpdir(), "creation-image-intent-"));
  directories.push(directory);
  const service = new CreationService(directory, silentLogger);
  let starts = 0;
  const create = async (upload: UploadedImage) => {
    const request = { config: { provider: "codex", cwd: "/project" }, imageUploads: [upload] };
    return await service.create({
      kind: "agent",
      key: "image-key",
      request,
      fingerprint: await fingerprintCreationIntent(paseoHome, request),
      hasAgent: true,
      hasPrompt: true,
      exists: async () => false,
      readAgent: async () => agent,
      createAgent: async (id, _workspace, onReady) => {
        starts++;
        const created = { ...agent, id };
        await onReady(created);
        return { agent: created, initialPromptStarted: true };
      },
    });
  };

  const first = await create(firstUpload);
  expect(first).toMatchObject({
    phase: "completed",
    agent: expect.objectContaining({ title: agent.title }),
  });
  expect(await create(retryUpload)).toEqual(first);
  expect(starts).toBe(1);
  await expect(create(otherUpload)).rejects.toThrow("agent_request_key_conflict");
});
