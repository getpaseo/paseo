import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowStorage } from "./storage.js";

const roots: string[] = [];

async function makeStorage(): Promise<{
  storage: WorkflowStorage;
  paseoHome: string;
  builtIns: string;
}> {
  const paseoHome = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-workflow-storage-"));
  roots.push(paseoHome);
  const builtIns = path.join(paseoHome, "built-ins");
  await fs.mkdir(builtIns);
  const storage = new WorkflowStorage({ paseoHome, builtInDirectory: builtIns });
  await storage.initialize();
  return { storage, paseoHome, builtIns };
}

function spec(name = "custom"): Record<string, unknown> {
  return {
    schemaVersion: "paseo.workflows.v0.2",
    name,
    description: "A custom workflow",
    workspace: {
      createWorktree: { cwd: "/repo", target: { mode: "branch-off", base: "main" } },
    },
    agents: {
      worker: {
        persistence: "reuse-agent",
        createAgent: {
          title: "Worker",
          provider: "codex",
          settings: { mode: "default" },
        },
      },
    },
    entry: "main",
    flows: {
      main: {
        initial: "done",
        states: { done: { return: { output: null } } },
      },
    },
    prompts: { unused: "Unused" },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("WorkflowStorage", () => {
  it("discovers built-ins and persists user JSON independently of code releases", async () => {
    const { storage, builtIns, paseoHome } = await makeStorage();
    await fs.writeFile(path.join(builtIns, "echo-demo.json"), JSON.stringify(spec("echo-demo")));

    await storage.saveUserSpec(spec("custom"));
    const summaries = await storage.listSpecs();

    expect(summaries.map(({ id, source }) => ({ id, source }))).toEqual([
      { id: "custom", source: "user" },
      { id: "echo-demo", source: "built-in" },
    ]);
    await expect(storage.getSpec("custom")).resolves.toMatchObject({ name: "custom" });
    await expect(
      fs.readFile(path.join(paseoHome, "workflows", "specs", "custom.json"), "utf8"),
    ).resolves.toContain('"schemaVersion": "paseo.workflows.v0.2"');
  });

  it("does not let pre-existing user files shadow built-in workflow identities", async () => {
    const { storage, builtIns } = await makeStorage();
    await fs.writeFile(
      path.join(builtIns, "echo-demo.json"),
      JSON.stringify({ ...spec("echo-demo"), description: "Built in" }),
    );
    await fs.writeFile(
      path.join(storage.userSpecRoot, "echo-demo.json"),
      JSON.stringify({ ...spec("echo-demo"), description: "Shadow" }),
    );

    await expect(storage.getSpec("echo-demo")).resolves.toMatchObject({
      description: "Built in",
    });
    expect((await storage.listSpecs()).find(({ id }) => id === "echo-demo")).toMatchObject({
      source: "built-in",
      description: "Built in",
    });
  });

  it("writes atomic state and append-only audit records", async () => {
    const { storage, paseoHome } = await makeStorage();
    const now = "2026-07-30T00:00:00.000Z";
    const state = {
      schemaVersion: "paseo.workflows.run.v0.2",
      runId: "run-1",
      workflow: { id: "custom", name: "custom" },
      status: "queued",
      reason: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
      loop: { iteration: 0, elapsedSeconds: 0 },
      instances: {},
    };
    await storage.createRun("run-1", spec(), state);
    await storage.appendEvent("run-1", {
      seq: 1,
      timestamp: now,
      type: "run_queued",
      details: { runId: "run-1" },
    });
    await storage.saveState("run-1", { ...state, status: "running" });

    const details = await storage.inspectRun("run-1");
    expect(details.run).toMatchObject({ id: "run-1", status: "running", legacy: false });
    expect(details.events).toEqual([
      expect.objectContaining({
        type: "run_queued",
        details: { runId: "run-1" },
      }),
    ]);
    const files = await fs.readdir(path.join(paseoHome, "workflows", "runs", "run-1"));
    expect(files.some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("reads historical spec.yaml runs without making unsafe legacy states resumable", async () => {
    const { storage, paseoHome } = await makeStorage();
    const runDir = path.join(paseoHome, "workflow-runs", "historical-run");
    await fs.mkdir(path.join(runDir, "rendered-prompts"), { recursive: true });
    await fs.writeFile(
      path.join(runDir, "spec.yaml"),
      [
        "schemaVersion: paseo.workflows.v0.2",
        "name: historical",
        "description: Historical fixture",
      ].join("\n"),
    );
    await fs.writeFile(
      path.join(runDir, "state.json"),
      JSON.stringify({
        runId: "historical-run",
        workflow: { name: "historical" },
        status: "stopped",
        stopReason: "requested",
        loop: { iteration: 3 },
      }),
    );
    await fs.writeFile(
      path.join(runDir, "events.jsonl"),
      '{"type":"workflow_stopped","stop_reason":"requested"}\n',
    );

    const details = await storage.inspectRun("historical-run");
    expect(details).toMatchObject({
      run: { id: "historical-run", legacy: true, resumable: false, status: "stopped" },
      spec: { schemaVersion: "paseo.workflows.v0.2", name: "historical" },
      events: [{ type: "workflow_stopped", details: { stop_reason: "requested" } }],
    });
  });

  it("rejects traversal, symlinked run targets, and corrupt state", async () => {
    const { storage, paseoHome } = await makeStorage();
    await expect(storage.getSpec("../secret")).rejects.toThrow("invalid workflow id");
    await expect(storage.inspectRun("../../secret")).rejects.toThrow("invalid workflow run id");

    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-workflow-outside-"));
    roots.push(outside);
    await fs.symlink(outside, path.join(paseoHome, "workflows", "runs", "linked-run"), "dir");
    await expect(storage.inspectRun("linked-run")).rejects.toThrow("symbolic link");

    const runDir = path.join(paseoHome, "workflows", "runs", "corrupt-run");
    await fs.mkdir(runDir);
    await fs.writeFile(path.join(runDir, "state.json"), "{");
    await fs.writeFile(path.join(runDir, "spec.json"), "{}");
    await expect(storage.inspectRun("corrupt-run")).rejects.toThrow("corrupt workflow state");

    const now = "2026-07-30T00:00:00.000Z";
    await storage.createRun("prompt-run", spec(), {
      runId: "prompt-run",
      workflow: { name: "custom" },
      status: "stopped",
      createdAt: now,
      updatedAt: now,
      loop: { iteration: 0 },
    });
    const secret = path.join(outside, "secret.txt");
    await fs.writeFile(secret, "historical private prompt");
    await fs.symlink(
      secret,
      path.join(paseoHome, "workflows", "runs", "prompt-run", "rendered-prompts", "leak.txt"),
    );
    await expect(storage.inspectRun("prompt-run")).rejects.toThrow("symbolic link");
  });
});
