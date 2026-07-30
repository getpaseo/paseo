import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  materializeWorkflowSpec,
  validateWorkflowTemplate,
  type WorkflowCallerContext,
} from "./spec.js";

function baseSpec(): Record<string, unknown> {
  return {
    schemaVersion: "paseo.workflows.v0.2",
    name: "test-workflow",
    description: "A public behavior fixture.",
    parameters: {
      objective: { type: "string", required: true, description: "Work to complete" },
      workspaceRef: {
        type: "string",
        required: true,
        defaultFrom: "current.workspace",
      },
      worktreeRef: {
        type: "path",
        required: true,
        defaultFrom: "current.worktree",
      },
      concurrency: { type: "integer", default: 2 },
    },
    bindings: {
      workspace: "{{ parameters.workspaceRef }}",
      worktree: "{{ parameters.worktreeRef }}",
    },
    workspace: {
      createWorktree: {
        cwd: "{{ parameters.worktreeRef }}",
        target: { mode: "branch-off", base: "main" },
      },
    },
    agents: {
      worker: {
        persistence: "reuse-agent",
        createAgent: {
          title: "Workflow worker",
          provider: "codex",
          model: "gpt-test",
          settings: { mode: "default", thinking: "low" },
        },
      },
    },
    protocol: { maxAttempts: 3 },
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
                  description: "The work is complete",
                  dataSchema: {
                    type: "object",
                    properties: { result: { type: "string" } },
                    required: ["result"],
                    additionalProperties: false,
                  },
                },
              },
            },
            on: { done: "finish", "error.agent": "failed", "error.protocol": "failed" },
          },
          finish: { return: { output: "{{ event.data.result }}" } },
          failed: { stop: { reason: "{{ event.message }}" } },
        },
      },
    },
    limits: { maxIterations: 5, maxRuntime: "1h" },
    inputs: {
      objective: "{{ parameters.objective }}",
      concurrency: "{{ parameters.concurrency }}",
    },
    prompts: { work: "Complete {{ objective }}." },
  };
}

describe("workflow spec validation and materialization", () => {
  it("preserves native JSON values and resolves caller defaults outside public parameters", () => {
    const context: WorkflowCallerContext = {
      workspaceId: "workspace-1",
      worktreePath: "/repo/worktree",
      agentId: "agent-1",
    };
    const result = materializeWorkflowSpec(
      baseSpec(),
      { objective: "Ship the change", concurrency: "4" },
      context,
    );

    expect(result.spec).toMatchObject({
      bindings: { workspace: "workspace-1", worktree: "/repo/worktree" },
      inputs: { objective: "Ship the change", concurrency: 4 },
    });
    expect(result.canonicalJson).toBe(canonicalJson(result.spec));
    expect(result.canonicalJson.startsWith('{"agents":')).toBe(true);
    expect(result.spec).not.toHaveProperty("parameters");
  });

  it("leaves optional caller bindings null when that current context does not exist", () => {
    const spec = baseSpec();
    const parameters = spec.parameters as Record<string, unknown>;
    parameters.agentRef = {
      type: "string",
      defaultFrom: "current.agent",
      description: "Optional current agent.",
    };
    (spec.bindings as Record<string, unknown>).agents = {
      worker: "{{ parameters.agentRef }}",
    };

    const result = materializeWorkflowSpec(
      spec,
      { objective: "Create a worker when no caller agent exists" },
      { workspaceId: "workspace-1", worktreePath: "/repo/worktree" },
    );

    expect(result.spec).toMatchObject({
      bindings: {
        workspace: "workspace-1",
        worktree: "/repo/worktree",
        agents: { worker: null },
      },
    });
  });

  it("rejects unknown fields, broken routes, undeclared parameters, and invalid event schemas", () => {
    const spec = baseSpec();
    spec.unexpected = true;
    const flows = spec.flows as Record<string, Record<string, unknown>>;
    const main = flows.main;
    const states = main.states as Record<string, Record<string, unknown>>;
    states.work.on = { missing: "nowhere" };
    const turn = states.work.turn as Record<string, unknown>;
    const emits = turn.emits as Record<string, Record<string, unknown>>;
    emits.done.dataSchema = { type: "definitely-not-a-json-schema-type" };
    (spec.inputs as Record<string, unknown>).missing = "{{ parameters.notDeclared }}";

    const result = validateWorkflowTemplate(spec);
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        "$.unexpected",
        "parameters.notDeclared",
        "flows.main.states.work.on.done",
        "flows.main.states.work.turn.emits.done.dataSchema",
      ]),
    );
  });

  it("validates every action and ordered bounded map declaration", () => {
    const spec = baseSpec();
    const flows = spec.flows as Record<string, Record<string, unknown>>;
    flows.child = {
      initial: "finish",
      inputs: {},
      states: { finish: { return: { output: "{{ inputs }}" } } },
    };
    const main = flows.main;
    const states = main.states as Record<string, Record<string, unknown>>;
    states.work = {
      call: { flow: "child", with: { objective: "{{ inputs.objective }}" } },
      on: { returned: "fanout", "error.agent": "failed", "error.protocol": "failed" },
    };
    states.fanout = {
      map: {
        group: "branches",
        items: "{{ event.data.items }}",
        as: "branch",
        call: { flow: "child", with: { branch: "{{ branch }}" } },
        join: "all",
        concurrency: 2,
      },
      on: { joined: "finish", "error.agent": "failed", "error.protocol": "failed" },
    };
    expect(validateWorkflowTemplate(spec)).toMatchObject({ valid: true, issues: [] });
  });
});
