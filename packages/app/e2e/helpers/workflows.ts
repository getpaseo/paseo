import type { WorkflowRunDetails, WorkflowRunStatus } from "@getpaseo/protocol/workflow/types";
import type { SeedDaemonClient } from "./seed-client";

type JsonObject = Record<string, unknown>;

export function buildTwoTurnWorkflow(input: { name: string; delayMs?: number }): JsonObject {
  const script = workflowScript(input.delayMs ?? 100, {
    next: [{ event: "next", message: "First turn handed off to the second." }],
    done: [
      {
        event: "done",
        message: "The deterministic workflow completed.",
        data: { value: "ordered result" },
      },
    ],
  });
  return {
    schemaVersion: "paseo.workflows.v0.2",
    name: input.name,
    description: "A sanitized real-daemon workflow fixture with two native agent turns.",
    parameters: {
      workspaceRef: {
        type: "string",
        required: true,
        defaultFrom: "current.workspace",
        description: "Existing Paseo workspace.",
      },
      worktreeRef: {
        type: "path",
        required: true,
        defaultFrom: "current.worktree",
        description: "Existing workspace directory.",
      },
    },
    bindings: {
      workspace: "{{ parameters.workspaceRef }}",
      worktree: "{{ parameters.worktreeRef }}",
    },
    workspace: {
      createWorktree: {
        cwd: "{{ parameters.worktreeRef }}",
        target: { mode: "branch-off" },
      },
    },
    agents: {
      worker: {
        persistence: "reuse-agent",
        createAgent: {
          title: "workflow E2E worker",
          provider: "mock",
          model: "ten-second-stream",
          settings: { modeId: "load-test" },
        },
      },
    },
    protocol: { maxAttempts: 2 },
    entry: "main",
    flows: {
      main: {
        initial: "first",
        states: {
          first: {
            turn: {
              agent: "worker",
              prompt: "first",
              emits: { next: { description: "Continue to the second turn." } },
            },
            on: {
              next: "second",
              "error.agent": "failed",
              "error.protocol": "failed",
            },
          },
          second: {
            turn: {
              agent: "worker",
              prompt: "second",
              emits: {
                done: {
                  description: "Return the ordered fixture result.",
                  dataSchema: {
                    type: "object",
                    properties: { value: { type: "string" } },
                    required: ["value"],
                    additionalProperties: false,
                  },
                },
              },
            },
            on: {
              done: "finish",
              "error.agent": "failed",
              "error.protocol": "failed",
            },
          },
          finish: { return: { output: "{{ event.data.value }}" } },
          failed: { stop: { reason: "{{ event.message }}" } },
        },
      },
    },
    limits: { maxIterations: 4, maxRuntime: "5m" },
    inputs: {},
    prompts: {
      first: `Complete the first deterministic workflow turn.\n${script}\n`,
      second: `Use the handoff and complete the second turn.\n${script}\n`,
    },
  };
}

export function buildSingleTurnWorkflow(input: { name: string; delayMs: number }): JsonObject {
  const spec = buildTwoTurnWorkflow(input);
  spec.description = "A sanitized real-daemon workflow fixture for native restart reconciliation.";
  spec.flows = {
    main: {
      initial: "work",
      states: {
        work: {
          turn: {
            agent: "worker",
            prompt: "work",
            emits: { done: { description: "Complete after native reconciliation." } },
          },
          on: {
            done: "finish",
            "error.agent": "failed",
            "error.protocol": "failed",
          },
        },
        finish: { return: { output: "{{ event.message }}" } },
        failed: { stop: { reason: "{{ event.message }}" } },
      },
    },
  };
  spec.limits = { maxIterations: 2, maxRuntime: "5m" };
  spec.prompts = {
    work:
      "Complete one deterministic turn across daemon restart.\n" +
      workflowScript(input.delayMs, {
        done: [{ event: "done", message: "Reconciled native turn completed." }],
      }) +
      "\n",
  };
  return spec;
}

export function buildFanoutWorkflow(name: string): JsonObject {
  return {
    schemaVersion: "paseo.workflows.v0.2",
    name,
    description: "A sanitized bounded fan-out fixture with isolated child workspaces.",
    parameters: {
      workspaceRef: {
        type: "string",
        required: true,
        defaultFrom: "current.workspace",
        description: "Existing Paseo workspace.",
      },
      worktreeRef: {
        type: "path",
        required: true,
        defaultFrom: "current.worktree",
        description: "Existing workspace directory.",
      },
    },
    bindings: {
      workspace: "{{ parameters.workspaceRef }}",
      worktree: "{{ parameters.worktreeRef }}",
    },
    workspace: {
      createWorktree: {
        cwd: "{{ parameters.worktreeRef }}",
        target: { mode: "branch-off" },
      },
    },
    agents: {
      worker: {
        persistence: "reuse-agent",
        createAgent: {
          title: "workflow fan-out worker",
          provider: "mock",
          model: "ten-second-stream",
          settings: { modeId: "load-test" },
        },
      },
    },
    protocol: { maxAttempts: 2 },
    entry: "main",
    flows: {
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
                    cwd: "{{ workspace.cwd }}",
                    name: "fanout child {{ task.index }}",
                    target: {
                      mode: "branch-off",
                      newBranch: `${name}-child-{{ task.index }}`,
                      base: "{{ workspace.branch }}",
                    },
                  },
                },
              },
              join: "all",
              concurrency: 2,
            },
            on: {
              joined: "finish",
              "error.agent": "failed",
              "error.timeout": "failed",
            },
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
                  description: "Return the child value.",
                  dataSchema: {
                    type: "object",
                    properties: { value: { type: "string" } },
                    required: ["value"],
                    additionalProperties: false,
                  },
                },
              },
            },
            on: {
              done: "finish",
              "error.agent": "failed",
              "error.protocol": "failed",
            },
          },
          finish: { return: { output: "{{ event.data.value }}" } },
          failed: { stop: { reason: "{{ event.message }}" } },
        },
      },
    },
    limits: { maxIterations: 6, maxRuntime: "5m" },
    inputs: { items: ["first", "second", "third"] },
    prompts: {
      child:
        "Process {{ inputs.value }}.\n" +
        workflowScript(250, {
          done: [
            {
              event: "done",
              message: "Child {{ task.index }} completed.",
              data: { value: "{{ inputs.value }}" },
            },
          ],
        }) +
        "\n",
    },
  };
}

export function goalDemoObjective(): string {
  return [
    "Advance a sanitized two-step objective and report completion evidence.",
    workflowScript(100, {
      continue: [
        { event: "continue", message: "Step one is complete; verify the final result." },
        { event: "complete", message: "Both steps are verified." },
      ],
    }),
  ].join("\n");
}

export function reviewedGoalDemoObjective(): string {
  return [
    "Produce and independently review a sanitized deliverable through one correction cycle.",
    workflowScript(100, {
      review: [
        { event: "review", message: "Initial worker evidence." },
        { event: "review", message: "Revised worker evidence." },
        { event: "review", message: "Finalized worker deliverable." },
        { event: "review", message: "Corrected final deliverable." },
      ],
      continue: [
        { event: "continue", message: "Revise the initial evidence." },
        {
          event: "ready_to_finalize",
          message: "The objective is proven; prepare the final deliverable.",
        },
      ],
      revise: [
        { event: "revise", message: "Tighten one final presentation detail." },
        { event: "complete", message: "The corrected final deliverable passes review." },
      ],
    }),
  ].join("\n");
}

export async function saveWorkflow(client: SeedDaemonClient, spec: JsonObject): Promise<string> {
  const payload = await client.workflowSpecSave(spec);
  if (payload.error || !payload.summary) {
    throw new Error(payload.error ?? "Workflow save returned no summary");
  }
  return payload.summary.id;
}

export async function startWorkflow(
  client: SeedDaemonClient,
  input: {
    workflowId: string;
    workspaceId: string;
    parameters?: Record<string, unknown>;
  },
): Promise<string> {
  const payload = await client.workflowRunStart({
    workflowId: input.workflowId,
    parameters: input.parameters,
    context: { workspaceId: input.workspaceId },
  });
  if (payload.error || !payload.run) {
    throw new Error(payload.error ?? "Workflow start returned no run");
  }
  return payload.run.id;
}

export async function waitForWorkflow(
  client: SeedDaemonClient,
  runId: string,
  statuses: WorkflowRunStatus[],
  timeoutMs = 30_000,
): Promise<WorkflowRunDetails> {
  const deadline = Date.now() + timeoutMs;
  let latest: WorkflowRunDetails | null = null;
  while (Date.now() < deadline) {
    const payload = await client.workflowRunInspect(runId);
    if (payload.error) throw new Error(payload.error);
    latest = payload.details;
    if (latest && statuses.includes(latest.run.status)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Workflow ${runId} did not reach ${statuses.join("/")} (last status: ${
      latest?.run.status ?? "missing"
    })`,
  );
}

function workflowScript(
  delayMs: number,
  rules: Record<string, Array<string | MockWorkflowEvent>>,
): string {
  return `PASEO_WORKFLOW_TEST_SCRIPT: ${JSON.stringify({ delayMs, rules })}`;
}

interface MockWorkflowEvent {
  event: string;
  message?: string;
  data?: unknown;
}
