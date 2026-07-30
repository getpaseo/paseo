import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  WorkflowRuntimeAdapter,
  WorkflowTurnReconciliation,
  WorkflowTurnRequest,
  WorkflowTurnResult,
} from "./runtime-adapter.js";
import { WorkflowService } from "./service.js";
import type { JsonObject, WorkflowCallerContext } from "./spec.js";
import type { WorkflowWorkspace } from "./state.js";
import { WorkflowStorage } from "./storage.js";

const roots: string[] = [];

interface PendingTurn {
  request: WorkflowTurnRequest;
  nativeTurnId: string;
  resolve: (result: WorkflowTurnResult) => void;
  result: Promise<WorkflowTurnResult>;
}

class FakeRuntimeAdapter implements WorkflowRuntimeAdapter {
  readonly starts: PendingTurn[] = [];
  readonly prompts: string[] = [];
  readonly agentCreates: Array<{ instanceId: string; role: string; agentId: string }> = [];
  readonly workspaceCreates: string[] = [];
  readonly idleWaits: string[] = [];
  validateGate: Promise<void> = Promise.resolve();
  idleGate: Promise<void> = Promise.resolve();
  maxActive = 0;
  private active = new Map<string, PendingTurn>();
  private nextAgent = 1;
  private nextTurn = 1;
  private waiters: Array<() => void> = [];
  private idleWaiters: Array<() => void> = [];

  async resolveCallerContext(input: {
    workspaceId?: string;
    agentId?: string;
  }): Promise<WorkflowCallerContext> {
    return {
      workspaceId: input.workspaceId,
      worktreePath: input.workspaceId ? "/repo" : undefined,
      agentId: input.agentId,
    };
  }

  async validateMaterializedSpec(): Promise<void> {
    await this.validateGate;
  }

  async ensureWorkspace(input: {
    instanceId: string;
    create: JsonObject;
  }): Promise<WorkflowWorkspace> {
    this.workspaceCreates.push(input.instanceId);
    return {
      workspaceId: `workspace-${input.instanceId}`,
      cwd: String(input.create.cwd ?? "/repo"),
      branch: `branch-${input.instanceId}`,
    };
  }

  async resolveBoundWorkspace(input: {
    workspaceId: string;
    worktreePath: string;
  }): Promise<WorkflowWorkspace> {
    return { workspaceId: input.workspaceId, cwd: input.worktreePath };
  }

  async ensureAgent(input: {
    instanceId: string;
    role: string;
    agentKey: string;
    existingAgentId: string | null;
  }): Promise<string> {
    if (input.existingAgentId) return input.existingAgentId;
    const agentId = `agent-${this.nextAgent++}`;
    this.agentCreates.push({ instanceId: input.instanceId, role: input.role, agentId });
    return agentId;
  }

  async waitUntilAgentIdle(agentId: string): Promise<void> {
    this.idleWaits.push(agentId);
    this.flushIdleWaiters();
    await this.idleGate;
  }

  async startTurn(
    request: WorkflowTurnRequest,
    onStarted: (nativeTurnId: string) => Promise<void>,
  ): Promise<WorkflowTurnResult> {
    const nativeTurnId = `native-turn-${this.nextTurn++}`;
    let resolve!: (result: WorkflowTurnResult) => void;
    const result = new Promise<WorkflowTurnResult>((resolvePromise) => {
      resolve = resolvePromise;
    });
    const pending = { request, nativeTurnId, resolve, result };
    this.starts.push(pending);
    this.prompts.push(request.prompt);
    this.active.set(request.agentId, pending);
    this.maxActive = Math.max(this.maxActive, this.active.size);
    await onStarted(nativeTurnId);
    this.flushWaiters();
    return result;
  }

  async reconcileTurn(input: {
    agentId: string;
    nativeTurnId: string | null;
  }): Promise<WorkflowTurnReconciliation> {
    const pending = this.active.get(input.agentId);
    if (!pending) return { state: "missing" };
    return {
      state: "active",
      nativeTurnId: pending.nativeTurnId,
      result: pending.result,
    };
  }

  getActiveTurnId(agentId: string): string | null {
    return this.active.get(agentId)?.nativeTurnId ?? null;
  }

  async waitForStarts(count: number): Promise<void> {
    if (this.starts.length >= count) return;
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    if (this.starts.length < count) await this.waitForStarts(count);
  }

  async waitForIdleWaits(count: number): Promise<void> {
    if (this.idleWaits.length >= count) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
    if (this.idleWaits.length < count) await this.waitForIdleWaits(count);
  }

  complete(agentId: string, status: WorkflowTurnResult["status"] = "completed"): void {
    const pending = this.active.get(agentId);
    if (!pending) throw new Error(`no active turn for ${agentId}`);
    this.active.delete(agentId);
    pending.resolve({
      agentId,
      nativeTurnId: pending.nativeTurnId,
      status,
      lastMessage: status === "completed" ? "finished" : "failed",
      lastError: status === "completed" ? null : "controlled failure",
    });
  }

  adopt(request: WorkflowTurnRequest, nativeTurnId: string): void {
    let resolve!: (result: WorkflowTurnResult) => void;
    const result = new Promise<WorkflowTurnResult>((resolvePromise) => {
      resolve = resolvePromise;
    });
    this.active.set(request.agentId, { request, nativeTurnId, resolve, result });
  }

  replaceActiveNativeTurnId(agentId: string, nativeTurnId: string): void {
    const pending = this.active.get(agentId);
    if (!pending) throw new Error(`no active turn for ${agentId}`);
    pending.nativeTurnId = nativeTurnId;
  }

  private flushWaiters(): void {
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  private flushIdleWaiters(): void {
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }
}

async function setup(spec: JsonObject): Promise<{
  service: WorkflowService;
  storage: WorkflowStorage;
  adapter: FakeRuntimeAdapter;
}> {
  const paseoHome = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-service-"));
  roots.push(paseoHome);
  const builtIns = path.join(paseoHome, "built-ins");
  await fs.mkdir(builtIns);
  await fs.writeFile(path.join(builtIns, `${String(spec.name)}.json`), JSON.stringify(spec));
  const storage = new WorkflowStorage({ paseoHome, builtInDirectory: builtIns });
  const adapter = new FakeRuntimeAdapter();
  const service = new WorkflowService({ storage, adapter });
  await service.initialize();
  return { service, storage, adapter };
}

function baseSpec(): JsonObject {
  return {
    schemaVersion: "paseo.workflows.v0.2",
    name: "runtime-fixture",
    description: "A sanitized runtime fixture",
    parameters: {
      objective: { type: "string", required: true },
      workspace: {
        type: "string",
        required: true,
        defaultFrom: "current.workspace",
      },
      worktree: {
        type: "path",
        required: true,
        defaultFrom: "current.worktree",
      },
    },
    bindings: {
      workspace: "{{ parameters.workspace }}",
      worktree: "{{ parameters.worktree }}",
    },
    workspace: {
      createWorktree: { cwd: "{{ parameters.worktree }}", target: { mode: "branch-off" } },
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
    protocol: { maxAttempts: 2 },
    entry: "main",
    flows: {
      main: {
        initial: "work",
        states: {
          work: {
            turn: {
              agent: "worker",
              prompt: "work",
              emits: {
                done: {
                  description: "Completed",
                  dataSchema: {
                    type: "object",
                    properties: { value: { type: "string" } },
                    required: ["value"],
                    additionalProperties: false,
                  },
                },
              },
            },
            on: { done: "finish", "error.agent": "failed", "error.protocol": "failed" },
          },
          finish: { return: { output: "{{ event.data.value }}" } },
          failed: { stop: { reason: "{{ event.message }}" } },
        },
      },
    },
    limits: { maxIterations: 10, maxRuntime: "1h" },
    inputs: { objective: "{{ parameters.objective }}" },
    prompts: { work: "Complete {{ objective }}." },
  };
}

function twoTurnSpec(persistence: "reuse-agent" | "fresh-agent"): JsonObject {
  const spec = baseSpec();
  const agents = spec.agents as JsonObject;
  const worker = agents.worker as JsonObject;
  worker.persistence = persistence;
  const flows = spec.flows as JsonObject;
  const main = flows.main as JsonObject;
  const states = main.states as JsonObject;
  states.work = {
    turn: {
      agent: "worker",
      prompt: "work",
      emits: { revised: { description: "Continue with a handoff" } },
    },
    on: { revised: "review", "error.agent": "failed", "error.protocol": "failed" },
  };
  states.review = {
    turn: {
      agent: "worker",
      prompt: "review",
      emits: { done: { description: "Finish" } },
    },
    on: { done: "finish", "error.agent": "failed", "error.protocol": "failed" },
  };
  (spec.prompts as JsonObject).review = "Review handoff: {{ event.message }}";
  return spec;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("WorkflowService runtime", () => {
  it("queues caller reuse immediately and waits for the invoking turn to become idle", async () => {
    const spec = baseSpec();
    (spec.parameters as JsonObject).workerThreadRef = {
      type: "string",
      required: true,
      defaultFrom: "current.agent",
    };
    (spec.bindings as JsonObject).agents = {
      worker: "{{ parameters.workerThreadRef }}",
    };
    const { service, adapter } = await setup(spec);
    let releaseIdle!: () => void;
    adapter.idleGate = new Promise<void>((resolve) => {
      releaseIdle = resolve;
    });

    const run = await service.startRun({
      workflowId: "runtime-fixture",
      parameters: { objective: "Continue this native thread" },
      context: { workspaceId: "workspace-root", agentId: "agent-caller" },
    });
    expect(run.status).toBe("queued");
    await adapter.waitForIdleWaits(1);
    expect(adapter.idleWaits).toEqual(["agent-caller"]);
    expect(adapter.starts).toHaveLength(0);

    releaseIdle();
    await adapter.waitForStarts(1);
    const turn = adapter.starts[0];
    expect(turn?.request.agentId).toBe("agent-caller");
    await service.emitEvent({
      callerAgentId: "agent-caller",
      event: "done",
      message: "caller thread continued",
      data: { value: "complete" },
    });
    adapter.complete("agent-caller");
    await expect(service.waitForRunTerminal(run.id)).resolves.toMatchObject({
      status: "complete",
    });
  });

  it("accepts immediately, authorizes the active native turn, validates data, and routes by tool event", async () => {
    const { service, adapter } = await setup(baseSpec());
    let releaseValidation!: () => void;
    adapter.validateGate = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });

    const run = await service.startRun({
      workflowId: "runtime-fixture",
      parameters: { objective: "Verify the native runtime" },
      context: { workspaceId: "workspace-root" },
    });
    expect(run.status).toBe("queued");
    expect(adapter.starts).toHaveLength(0);

    releaseValidation();
    await adapter.waitForStarts(1);
    const turn = adapter.starts[0];
    await expect(
      service.emitEvent({
        callerAgentId: "wrong-agent",
        event: "done",
        message: "not authorized",
        data: { value: "wrong" },
      }),
    ).rejects.toThrow("not an active workflow turn");
    await expect(
      service.emitEvent({
        callerAgentId: turn.request.agentId,
        event: "done",
        message: "invalid",
        data: {},
      }),
    ).rejects.toThrow("event data");
    const originalNativeTurnId = turn.nativeTurnId;
    adapter.replaceActiveNativeTurnId(turn.request.agentId, "native-turn-stale");
    await expect(
      service.emitEvent({
        callerAgentId: turn.request.agentId,
        event: "done",
        message: "stale",
        data: { value: "stale" },
      }),
    ).rejects.toThrow("does not own the active native turn");
    adapter.replaceActiveNativeTurnId(turn.request.agentId, originalNativeTurnId);

    const concurrent = await Promise.allSettled([
      service.emitEvent({
        callerAgentId: turn.request.agentId,
        event: "done",
        message: "handoff",
        data: { value: "ordered result" },
      }),
      service.emitEvent({
        callerAgentId: turn.request.agentId,
        event: "done",
        message: "replay",
        data: { value: "ordered result" },
      }),
    ]);
    expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(concurrent.filter((result) => result.status === "rejected")).toHaveLength(1);
    adapter.complete(turn.request.agentId);

    const finished = await service.waitForRunTerminal(run.id);
    expect(finished).toMatchObject({ status: "complete", reason: "returned" });
    const details = await service.inspectRun(run.id);
    expect(details.state.result).toBe("ordered result");
    expect(details.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "turn_started",
        "event_accepted",
        "state_transition",
        "run_completed",
      ]),
    );
    expect(details.prompts[0].content).toContain("call `emit_event` exactly once");
  });

  it("uses same-agent repair when prose ends without an event", async () => {
    const { service, adapter } = await setup(baseSpec());
    const run = await service.startRun({
      workflowId: "runtime-fixture",
      parameters: { objective: "Repair routing" },
      context: { workspaceId: "workspace-root" },
    });
    await adapter.waitForStarts(1);
    const first = adapter.starts[0];
    adapter.complete(first.request.agentId);
    await adapter.waitForStarts(2);
    const repair = adapter.starts[1];
    expect(repair.request.agentId).toBe(first.request.agentId);
    expect(repair.request.prompt).toContain("could not be routed");
    await service.emitEvent({
      callerAgentId: repair.request.agentId,
      event: "done",
      message: "repaired",
      data: { value: "done" },
    });
    adapter.complete(repair.request.agentId);
    await expect(service.waitForRunTerminal(run.id)).resolves.toMatchObject({
      status: "complete",
    });
  });

  it("routes exhausted repair and native agent failures through explicit runtime routes", async () => {
    const protocolCase = await setup(baseSpec());
    const protocolRun = await protocolCase.service.startRun({
      workflowId: "runtime-fixture",
      parameters: { objective: "Exhaust repair" },
      context: { workspaceId: "workspace-root" },
    });
    await protocolCase.adapter.waitForStarts(1);
    protocolCase.adapter.complete(protocolCase.adapter.starts[0].request.agentId);
    await protocolCase.adapter.waitForStarts(2);
    protocolCase.adapter.complete(protocolCase.adapter.starts[1].request.agentId);
    await expect(protocolCase.service.waitForRunTerminal(protocolRun.id)).resolves.toMatchObject({
      status: "complete",
      reason: expect.stringContaining("without one allowed workflow event"),
    });

    const agentCase = await setup(baseSpec());
    const agentRun = await agentCase.service.startRun({
      workflowId: "runtime-fixture",
      parameters: { objective: "Route failure" },
      context: { workspaceId: "workspace-root" },
    });
    await agentCase.adapter.waitForStarts(1);
    agentCase.adapter.complete(agentCase.adapter.starts[0].request.agentId, "failed");
    await expect(agentCase.service.waitForRunTerminal(agentRun.id)).resolves.toMatchObject({
      status: "complete",
      reason: "controlled failure",
    });
  });

  it("preserves event.message handoff while honoring reuse-agent and fresh-agent declarations", async () => {
    for (const [persistence, expectedCreates] of [
      ["reuse-agent", 1],
      ["fresh-agent", 2],
    ] as const) {
      const { service, adapter } = await setup(twoTurnSpec(persistence));
      const run = await service.startRun({
        workflowId: "runtime-fixture",
        parameters: { objective: persistence },
        context: { workspaceId: "workspace-root" },
      });
      await adapter.waitForStarts(1);
      const first = adapter.starts[0];
      await service.emitEvent({
        callerAgentId: first.request.agentId,
        event: "revised",
        message: "review this exact handoff",
      });
      adapter.complete(first.request.agentId);
      await adapter.waitForStarts(2);
      const second = adapter.starts[1];
      expect(second.request.prompt).toContain("review this exact handoff");
      if (persistence === "reuse-agent") {
        expect(second.request.agentId).toBe(first.request.agentId);
      } else {
        expect(second.request.agentId).not.toBe(first.request.agentId);
      }
      await service.emitEvent({
        callerAgentId: second.request.agentId,
        event: "done",
        message: "complete",
        data: { value: "done" },
      });
      adapter.complete(second.request.agentId);
      await expect(service.waitForRunTerminal(run.id)).resolves.toMatchObject({
        status: "complete",
      });
      expect(adapter.agentCreates).toHaveLength(expectedCreates);
    }
  });

  it("runs bounded maps concurrently and gathers results in input order", async () => {
    const workflow = baseSpec();
    workflow.inputs = { items: ["first", "second", "third"] };
    workflow.flows = {
      main: {
        initial: "fanout",
        states: {
          fanout: {
            map: {
              group: "items",
              items: "{{ inputs.items }}",
              as: "item",
              call: {
                flow: "child",
                with: { value: "{{ item }}" },
                workspace: {
                  createWorktree: {
                    cwd: "/repo",
                    name: "child-{{ task.index }}",
                    target: { mode: "branch-off", base: "main" },
                  },
                },
              },
              join: "all",
              concurrency: 2,
            },
            on: { joined: "finish", "error.agent": "failed", "error.protocol": "failed" },
          },
          finish: { return: { output: "{{ event.data.results }}" } },
          failed: { stop: { reason: "{{ event.message }}" } },
        },
      },
      child: {
        initial: "work",
        inputs: { value: "" },
        states: {
          work: {
            turn: {
              agent: "worker",
              prompt: "child",
              emits: {
                done: {
                  description: "Completed child",
                  dataSchema: {
                    type: "object",
                    properties: { value: { type: "string" } },
                    required: ["value"],
                  },
                },
              },
            },
            on: { done: "finish", "error.agent": "failed", "error.protocol": "failed" },
          },
          finish: { return: { output: "{{ event.data.value }}" } },
          failed: { stop: { reason: "{{ event.message }}" } },
        },
      },
    };
    (workflow.prompts as JsonObject).child = "Process {{ inputs.value }}.";
    const { service, adapter } = await setup(workflow);
    const run = await service.startRun({
      workflowId: "runtime-fixture",
      parameters: { objective: "unused" },
      context: { workspaceId: "workspace-root" },
    });
    await adapter.waitForStarts(2);
    expect(adapter.maxActive).toBe(2);
    expect(adapter.workspaceCreates).toHaveLength(2);

    const second = adapter.starts[1];
    await service.emitEvent({
      callerAgentId: second.request.agentId,
      event: "done",
      message: "second first",
      data: { value: "SECOND" },
    });
    adapter.complete(second.request.agentId);
    await adapter.waitForStarts(3);
    expect(adapter.maxActive).toBe(2);

    const first = adapter.starts[0];
    await service.emitEvent({
      callerAgentId: first.request.agentId,
      event: "done",
      message: "first second",
      data: { value: "FIRST" },
    });
    adapter.complete(first.request.agentId);
    const third = adapter.starts[2];
    await service.emitEvent({
      callerAgentId: third.request.agentId,
      event: "done",
      message: "third",
      data: { value: "THIRD" },
    });
    adapter.complete(third.request.agentId);

    await service.waitForRunTerminal(run.id);
    expect(adapter.workspaceCreates).toHaveLength(3);
    const details = await service.inspectRun(run.id);
    const result = details.state.result as Array<{ index: number; output: string }>;
    expect(result.map(({ index, output }) => ({ index, output }))).toEqual([
      { index: 0, output: "FIRST" },
      { index: 1, output: "SECOND" },
      { index: 2, output: "THIRD" },
    ]);
  });

  it("drains active turns on stop, launches nothing new, then resumes remaining map work", async () => {
    const workflow = baseSpec();
    workflow.inputs = { items: ["one", "two", "three"] };
    workflow.flows = {
      main: {
        initial: "fanout",
        states: {
          fanout: {
            map: {
              group: "items",
              items: "{{ inputs.items }}",
              as: "item",
              call: { flow: "child", with: { value: "{{ item }}" } },
              join: "all",
              concurrency: 2,
            },
            on: { joined: "finish", "error.agent": "failed", "error.protocol": "failed" },
          },
          finish: { return: { output: "{{ event.data.results }}" } },
          failed: { stop: { reason: "{{ event.message }}" } },
        },
      },
      child: {
        initial: "work",
        inputs: { value: "" },
        states: {
          work: {
            turn: {
              agent: "worker",
              prompt: "child",
              emits: { done: { description: "Child completed" } },
            },
            on: { done: "finish", "error.agent": "failed", "error.protocol": "failed" },
          },
          finish: { return: { output: "{{ inputs.value }}" } },
          failed: { stop: { reason: "{{ event.message }}" } },
        },
      },
    };
    (workflow.prompts as JsonObject).child = "Process {{ inputs.value }}.";
    const { service, adapter } = await setup(workflow);
    const run = await service.startRun({
      workflowId: "runtime-fixture",
      parameters: { objective: "unused" },
      context: { workspaceId: "workspace-root" },
    });
    await adapter.waitForStarts(2);
    await expect(service.stopRun(run.id)).resolves.toMatchObject({ status: "stopping" });
    for (const turn of adapter.starts.slice(0, 2)) {
      await service.emitEvent({
        callerAgentId: turn.request.agentId,
        event: "done",
        message: "drained",
      });
      adapter.complete(turn.request.agentId);
    }
    await expect(service.waitForRunTerminal(run.id)).resolves.toMatchObject({
      status: "stopped",
      reason: "requested",
    });
    expect(adapter.starts).toHaveLength(2);

    await service.resumeRun(run.id);
    await adapter.waitForStarts(3);
    const third = adapter.starts[2];
    await service.emitEvent({
      callerAgentId: third.request.agentId,
      event: "done",
      message: "resumed",
    });
    adapter.complete(third.request.agentId);
    await expect(service.waitForRunTerminal(run.id)).resolves.toMatchObject({
      status: "complete",
    });
  });

  it("reconciles a persisted native turn after restart without launching a duplicate", async () => {
    const firstProcess = await setup(baseSpec());
    const run = await firstProcess.service.startRun({
      workflowId: "runtime-fixture",
      parameters: { objective: "Restart safely" },
      context: { workspaceId: "workspace-root" },
    });
    await firstProcess.adapter.waitForStarts(1);
    const active = firstProcess.adapter.starts[0];
    firstProcess.service.dispose();

    const restartedAdapter = new FakeRuntimeAdapter();
    restartedAdapter.adopt(active.request, active.nativeTurnId);
    const restartedService = new WorkflowService({
      storage: firstProcess.storage,
      adapter: restartedAdapter,
    });
    await restartedService.initialize();
    await restartedService.emitEvent({
      callerAgentId: active.request.agentId,
      event: "done",
      message: "continued after restart",
      data: { value: "reconciled" },
    });
    restartedAdapter.complete(active.request.agentId);

    await expect(restartedService.waitForRunTerminal(run.id)).resolves.toMatchObject({
      status: "complete",
      reason: "returned",
    });
    expect(restartedAdapter.starts).toHaveLength(0);
    const details = await restartedService.inspectRun(run.id);
    expect(details.events.filter((event) => event.type === "turn_started")).toHaveLength(1);
    expect(details.events.filter((event) => event.type === "event_accepted")).toHaveLength(1);
  });

  it("applies turn and runtime limits without blocking a terminal return", async () => {
    const turnLimitedSpec = twoTurnSpec("reuse-agent");
    turnLimitedSpec.limits = { maxIterations: 1, maxRuntime: "1h" };
    const turnLimited = await setup(turnLimitedSpec);
    const turnRun = await turnLimited.service.startRun({
      workflowId: "runtime-fixture",
      parameters: { objective: "One turn only" },
      context: { workspaceId: "workspace-root" },
    });
    await turnLimited.adapter.waitForStarts(1);
    const first = turnLimited.adapter.starts[0];
    await turnLimited.service.emitEvent({
      callerAgentId: first.request.agentId,
      event: "revised",
      message: "would require another turn",
    });
    turnLimited.adapter.complete(first.request.agentId);
    await expect(turnLimited.service.waitForRunTerminal(turnRun.id)).resolves.toMatchObject({
      status: "stopped",
      reason: "max_iterations",
    });
    expect(turnLimited.adapter.starts).toHaveLength(1);

    const terminalSpec = baseSpec();
    terminalSpec.limits = { maxIterations: 1, maxRuntime: "1h" };
    const terminal = await setup(terminalSpec);
    const terminalRun = await terminal.service.startRun({
      workflowId: "runtime-fixture",
      parameters: { objective: "Return after one turn" },
      context: { workspaceId: "workspace-root" },
    });
    await terminal.adapter.waitForStarts(1);
    const only = terminal.adapter.starts[0];
    await terminal.service.emitEvent({
      callerAgentId: only.request.agentId,
      event: "done",
      message: "done",
      data: { value: "terminal" },
    });
    terminal.adapter.complete(only.request.agentId);
    await expect(terminal.service.waitForRunTerminal(terminalRun.id)).resolves.toMatchObject({
      status: "complete",
      reason: "returned",
    });

    const runtime = await setup(baseSpec());
    const runtimeRun = await runtime.service.startRun({
      workflowId: "runtime-fixture",
      parameters: { objective: "Runtime bound" },
      context: { workspaceId: "workspace-root" },
    });
    await runtime.adapter.waitForStarts(1);
    const runtimeTurn = runtime.adapter.starts[0];
    const state = await runtime.storage.readState(runtimeRun.id);
    state.startedAt = new Date(0).toISOString();
    await runtime.storage.saveState(runtimeRun.id, state);
    await runtime.service.emitEvent({
      callerAgentId: runtimeTurn.request.agentId,
      event: "done",
      message: "too late",
      data: { value: "late" },
    });
    runtime.adapter.complete(runtimeTurn.request.agentId);
    await expect(runtime.service.waitForRunTerminal(runtimeRun.id)).resolves.toMatchObject({
      status: "stopped",
      reason: "max_runtime",
    });
  });
});
