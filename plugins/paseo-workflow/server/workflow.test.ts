import { expect, test } from "vitest";
import {
  WorkflowController,
  type WorkflowPort,
  type WorkflowAgent,
  type WorkflowState,
} from "./workflow";
import { profiles } from "../shared/profiles";

function fixture() {
  const launches: Parameters<WorkflowPort["create"]>[0][] = [];
  const prompts: Array<{ agentId: string; text: string; messageId: string }> = [];
  const decisions: string[] = [];
  const agents = new Map<string, WorkflowAgent>([
    [
      "planner",
      {
        id: "planner",
        workspaceId: "workspace",
        launchProfileId: "paseo-workflow-planner",
        labels: {},
        pendingPermissions: [
          {
            id: "permission-1",
            kind: "plan" as const,
            sourcePlanCallId: "plan-1",
            input: { plan: "Exact (c) plan" },
          },
        ],
      },
    ],
  ]);
  let stored: WorkflowState = { workflows: {} };
  let installed = [...profiles];
  const port: WorkflowPort = {
    profiles: async () => installed,
    agent: async (id) => {
      const value = agents.get(id);
      if (!value) throw new Error("Unknown agent");
      return value;
    },
    workspace: async () => ({ cwd: "/workspace", intent: "Keep the user in control" }),
    timeline: async () => [{ type: "user_message", text: "Build the requested feature" }],
    git: async () => ({ base: "abc123", branch: "feature", dirty: " M existing.ts" }),
    diff: async () => ({
      head: "functional-commit",
      text: "diff --git a/feature.ts b/feature.ts",
      dirtyFiles: ["existing.ts"],
      untrackedFiles: [],
    }),
    commitCount: async () => 1,
    create: async (input) => {
      launches.push(input);
      const id = `child-${launches.length}`;
      agents.set(id, {
        id,
        workspaceId: input.workspaceId,
        launchProfileId: input.launchProfileId,
        labels: input.labels,
        pendingPermissions: [],
      });
      return id;
    },
    send: async (agentId, text, messageId) => {
      prompts.push({ agentId, text, messageId });
    },
    respond: async (agentId, requestId) => {
      decisions.push(requestId);
      agents.get(agentId)!.pendingPermissions = [];
    },
    read: async () => structuredClone(stored),
    write: async (value) => {
      stored = structuredClone(value);
    },
  };
  return {
    port,
    launches,
    prompts,
    decisions,
    agents,
    removeProfile: (id: string) => {
      installed = installed.filter((profile) => profile.id !== id);
    },
  };
}

const plan = {
  workspaceId: "workspace",
  agentId: "planner",
  permissionRequestId: "permission-1",
  callId: "plan-1",
  text: "Exact (c) plan",
};

test("permission lifecycle reviews once and approval selects the exact plan for same-agent final review", async () => {
  const f = fixture();
  const controller = new WorkflowController(f.port);
  await controller.planRequested(plan);
  expect(f.launches).toHaveLength(1);
  await controller.finished("child-1", "Clarify tests");
  const next = { ...plan, callId: "plan-2", permissionRequestId: "permission-2", text: "Revised" };
  f.agents.get("planner")!.pendingPermissions = [
    {
      id: next.permissionRequestId,
      kind: "plan",
      sourcePlanCallId: next.callId,
      input: { plan: next.text },
    },
  ];
  await controller.planRequested(next);
  expect(f.launches).toHaveLength(1);
  await controller.approved("planner", next.permissionRequestId);
  await controller.finished("planner", "Implemented in the same conversation");
  expect(f.launches.at(-1)).toMatchObject({
    launchProfileId: "paseo-workflow-final-review",
    labels: { "paseo.workflow.plan": "plan-2" },
  });
});

test("an executor's question does not start final review before a functional commit exists", async () => {
  const f = fixture();
  const completedDiff = f.port.diff;
  f.port.diff = async () => ({ head: "abc123", text: "", dirtyFiles: [], untrackedFiles: [] });
  const controller = new WorkflowController(f.port);
  await controller.handoff(plan, "standard");
  await controller.finished("child-1", "Which behavior do you prefer?");
  expect(f.launches).toHaveLength(1);
  f.port.diff = completedDiff;
  await controller.finished("child-1", "Implemented and committed");
  expect(f.launches).toHaveLength(2);
});

test("unrelated tool approvals never select a workflow plan or start final review", async () => {
  const f = fixture();
  const controller = new WorkflowController(f.port);
  await controller.prepareHandoff(plan);
  await controller.approved("planner", "unrelated-tool");
  await controller.finished("planner", "Tool finished");
  expect(f.launches).toEqual([]);
  expect((await f.port.read()).workflows.planner.activePlanId).toBeUndefined();
});

test.each([
  ["SIMPLE", ["audit-economic"]],
  ["STRUCTURAL", ["audit-deep"]],
  ["SENSITIVE", ["audit-deep", "audit-security"]],
] as const)(
  "final review %s creates only its bounded read-only audit fanout and reserves writing for the manager",
  async (classification, auditors) => {
    const f = fixture();
    const controller = new WorkflowController(f.port);
    await controller.handoff(plan, "standard");
    await controller.finished("child-1", "Functional commit verified");
    expect(f.launches[1]).toMatchObject({
      launchProfileId: "paseo-workflow-final-review",
      config: { writePolicy: "read_write" },
    });
    expect(f.prompts[1].text).toContain("diff --git");
    await controller.finished("child-2", JSON.stringify({ classification }));
    expect(f.launches.slice(2).map((input) => input.labels["paseo.workflow.role"])).toEqual(
      auditors,
    );
    expect(
      f.launches
        .slice(2)
        .every((input) => input.config.writePolicy === "read_only" && input.parent === "child-2"),
    ).toBe(true);
    await new WorkflowController(f.port).finished("child-2", JSON.stringify({ classification }));
    expect(f.launches).toHaveLength(2 + auditors.length);
  },
);

test("final review refuses unsafe corrections and treats manager assertions without tool evidence as verification_required", async () => {
  const f = fixture();
  f.port.git = async () => ({ base: "abc123", branch: "feature", dirty: "" });
  f.port.diff = async () => ({
    head: "functional-commit",
    text: "functional diff",
    dirtyFiles: [],
    untrackedFiles: [],
  });
  const controller = new WorkflowController(f.port);
  await controller.handoff(plan, "standard");
  await controller.finished("child-1", "Done");
  await controller.finished("child-2", '{"classification":"SIMPLE"}');
  await controller.finished(
    "child-3",
    JSON.stringify({
      findings: [
        {
          summary: "Missing boundary check",
          files: ["feature.ts"],
          certain: true,
          local: true,
          verifiable: true,
          externalEffects: false,
        },
      ],
    }),
  );
  await controller.finished(
    "child-2",
    JSON.stringify({
      correct: true,
      validationCommands: ["npx vitest run feature.test.ts --bail=1"],
    }),
  );
  expect(f.prompts.at(-1)?.text).toContain("Do not commit");
  await controller.finished("child-2", '{"validated":true}');
  const final = (await f.port.read()).workflows.planner.plans["plan-1"].final;
  expect(final?.phase).toBe("verification_required");
  expect(final?.reason).toContain("evidence");
  expect(f.launches).toHaveLength(3);
  expect(f.prompts.every((prompt) => !prompt.text.startsWith("Create the correction commit"))).toBe(
    true,
  );
});

test("uncertain findings never authorize correction", async () => {
  const f = fixture();
  const controller = new WorkflowController(f.port);
  await controller.handoff(plan, "standard");
  await controller.finished("child-1", "Done");
  await controller.finished("child-2", '{"classification":"SIMPLE"}');
  await controller.finished(
    "child-3",
    JSON.stringify({
      findings: [
        {
          summary: "Maybe redesign",
          files: ["feature.ts"],
          certain: false,
          local: true,
          verifiable: true,
          externalEffects: false,
        },
      ],
    }),
  );
  await controller.finished(
    "child-2",
    JSON.stringify({ correct: true, validationCommands: ["test"] }),
  );
  expect((await f.port.read()).workflows.planner.plans["plan-1"].final?.phase).toBe(
    "verification_required",
  );
  expect(f.prompts.every((prompt) => !prompt.text.startsWith("Correct only"))).toBe(true);
});

test.each([
  "verified",
  "tool-after-check",
  "foreign-dirty-file",
  "untracked-correction",
  "delta-concurrent-file",
  "extra-commit",
])("correction evidence stays bounded (%s)", async (scenario) => {
  const f = fixture();
  f.port.git = async () => ({ base: "abc123", branch: "feature", dirty: "" });
  f.port.diff = async () => ({
    head: "functional-commit",
    text: "functional diff",
    dirtyFiles: [],
    untrackedFiles: [],
  });
  const controller = new WorkflowController(f.port);
  await controller.handoff(plan, "standard");
  await controller.finished("child-1", "Done");
  await controller.finished("child-2", '{"classification":"SIMPLE"}');
  await controller.finished(
    "child-3",
    JSON.stringify({
      findings: [
        {
          summary: "Boundary",
          files: ["feature.ts"],
          certain: true,
          local: true,
          verifiable: true,
          externalEffects: false,
        },
      ],
    }),
  );
  const command = "npx vitest run feature.test.ts --bail=1";
  await controller.finished(
    "child-2",
    JSON.stringify({ correct: true, validationCommands: [command] }),
  );
  f.port.diff = async () => ({
    head: "functional-commit",
    text: "corrected delta",
    dirtyFiles: scenario === "foreign-dirty-file" ? ["existing.ts", "feature.ts"] : ["feature.ts"],
    untrackedFiles: scenario === "untracked-correction" ? ["feature.ts"] : [],
  });
  const checks: Parameters<WorkflowController["finished"]>[2] = [
    {
      type: "tool_call",
      callId: "test",
      name: "shell",
      status: "completed",
      error: null,
      detail: { type: "shell", command, exitCode: 0 },
    },
  ];
  if (scenario === "tool-after-check")
    checks.push({
      type: "tool_call",
      callId: "edit",
      name: "shell",
      status: "completed",
      error: null,
      detail: { type: "shell", command: "modify-files", exitCode: 0 },
    });
  await controller.finished("child-2", "Checks passed", checks);
  if (
    scenario === "tool-after-check" ||
    scenario === "foreign-dirty-file" ||
    scenario === "untracked-correction"
  ) {
    expect((await f.port.read()).workflows.planner.plans["plan-1"].final?.phase).toBe(
      "verification_required",
    );
    expect(f.launches).toHaveLength(3);
    return;
  }
  expect(f.launches.at(-1)).toMatchObject({
    parent: "child-2",
    config: { writePolicy: "read_only" },
    labels: { "paseo.workflow.role": "delta-review" },
  });
  if (scenario === "delta-concurrent-file")
    f.port.diff = async () => ({
      head: "functional-commit",
      text: "corrected delta",
      dirtyFiles: ["feature.ts", "other.ts"],
      untrackedFiles: [],
    });
  await controller.finished("child-4", '{"findings":[]}');
  if (scenario === "delta-concurrent-file") {
    expect((await f.port.read()).workflows.planner.plans["plan-1"].final?.phase).toBe(
      "verification_required",
    );
    expect(
      f.prompts.every((prompt) => !prompt.text.startsWith("Create the correction commit")),
    ).toBe(true);
    return;
  }
  expect(f.prompts.at(-1)).toMatchObject({ agentId: "child-2" });
  expect(f.prompts.at(-1)?.text).toMatch(/^Create the correction commit/);
  await new WorkflowController(f.port).finished("child-4", '{"findings":[]}');
  expect(f.launches).toHaveLength(4);
  expect(
    f.prompts.filter((prompt) => prompt.text.startsWith("Create the correction commit")),
  ).toHaveLength(1);
  f.port.diff = async () => ({
    head: "correction-commit",
    text: "corrected delta",
    dirtyFiles: [],
    untrackedFiles: [],
  });
  f.port.commitCount = async () => (scenario === "extra-commit" ? 2 : 1);
  await controller.finished("child-2", "Committed");
  expect((await f.port.read()).workflows.planner.plans["plan-1"].final?.phase).toBe(
    scenario === "extra-commit" ? "verification_required" : "complete",
  );
});

test("Router consumes persisted intent and request, persists its recommendation, and launches one planner", async () => {
  const f = fixture();
  f.agents.set("router", {
    id: "router",
    workspaceId: "workspace",
    launchProfileId: "paseo-workflow-router",
    labels: {},
    pendingPermissions: [],
  });
  f.port.timeline = async () => [
    { type: "user_message", text: "Build the requested feature" },
    { type: "assistant_message", text: "Which constraint?" },
    { type: "user_message", text: "Only local data, never production" },
  ];
  const controller = new WorkflowController(f.port);
  const decision = JSON.stringify({
    ready: true,
    recommendation: "advanced",
    constraints: ["No external effects"],
    assumptions: ["Keep API compatible"],
  });
  await controller.finished("router", decision);
  await new WorkflowController(f.port).finished("router", decision);
  expect(f.launches).toHaveLength(1);
  expect(f.launches[0]).toMatchObject({
    launchProfileId: "paseo-workflow-planner",
    labels: { "paseo.workflow.id": "router" },
  });
  expect(f.prompts[0].text).toContain("Keep the user in control");
  expect(f.prompts[0].text).toContain("Build the requested feature");
  expect(f.prompts[0].text).toContain("Only local data, never production");
  expect(f.prompts[0].text).toContain("Keep API compatible");
  expect((await f.port.read()).workflows.router.recommendation).toBe("advanced");
});

test.each(["review", "handoff"] as const)(
  "%s resumes a persisted closed operation without answering the permission twice",
  async (action) => {
    const f = fixture();
    const create = f.port.create;
    f.port.create = async () => {
      throw new Error("Temporary spawn failure");
    };
    const invoke = (controller: WorkflowController) =>
      action === "review"
        ? controller.review(plan, "manual")
        : controller.handoff(plan, "standard");
    await expect(invoke(new WorkflowController(f.port))).rejects.toThrow("Temporary spawn failure");
    f.port.create = create;
    expect(await invoke(new WorkflowController(f.port))).toEqual({ agentId: "child-1" });
    expect(f.decisions).toEqual(["permission-1"]);
    expect(f.launches).toHaveLength(1);
  },
);

test("handoff persists the selected executor and launches one root with the original git and intent context", async () => {
  const f = fixture();
  const controller = new WorkflowController(f.port);
  await expect(controller.handoff(plan)).rejects.toThrow("Choose");
  const results = await Promise.all([
    controller.handoff(plan, "advanced"),
    controller.handoff(plan, "advanced"),
  ]);
  expect(results).toEqual([{ agentId: "child-1" }, { agentId: "child-1" }]);
  expect(f.launches).toHaveLength(1);
  expect(f.launches[0]).not.toHaveProperty("parent");
  expect(f.launches[0]).toMatchObject({
    workspaceId: "workspace",
    launchProfileId: "paseo-workflow-executor-advanced",
    config: { writePolicy: "read_write" },
  });
  expect(f.prompts[0].text).toMatch(/^\/paseo-handoff/);
  expect(f.prompts[0].text).toContain("abc123");
  expect(f.prompts[0].text).toContain(" M existing.ts");
  expect(f.prompts[0].text).toContain("Keep the user in control");
  expect(f.decisions).toEqual(["permission-1"]);
  expect((await f.port.read()).workflows.planner.plans["plan-1"].handoff?.selection).toBe(
    "advanced",
  );
});

test("missing profiles and stale plan contexts reject before closing or launching", async () => {
  const f = fixture();
  const controller = new WorkflowController(f.port);
  f.removeProfile("paseo-workflow-plan-reviewer");
  await expect(controller.review(plan, "manual")).rejects.toThrow("Install / repair profiles");
  f.removeProfile("paseo-workflow-executor-standard");
  await expect(controller.handoff(plan, "standard")).rejects.toThrow(
    "paseo-workflow-executor-standard",
  );
  await expect(controller.handoff({ ...plan, workspaceId: "other" }, "advanced")).rejects.toThrow(
    "workspace",
  );
  await expect(controller.handoff({ ...plan, text: "stale" }, "advanced")).rejects.toThrow(
    "text changed",
  );
  expect(f.decisions).toEqual([]);
  expect(f.launches).toEqual([]);
});

test("review closes the exact plan, launches one read-only child, and survives duplicate clicks", async () => {
  const f = fixture();
  const controller = new WorkflowController(f.port);
  const results = await Promise.all([
    controller.review(plan, "automatic"),
    controller.review(plan, "automatic"),
  ]);
  expect(results).toEqual([{ agentId: "child-1" }, { agentId: "child-1" }]);
  expect(f.launches).toHaveLength(1);
  expect(f.launches[0]).toMatchObject({
    workspaceId: "workspace",
    parent: "planner",
    launchProfileId: "paseo-workflow-plan-reviewer",
    config: { writePolicy: "read_only" },
    labels: {
      "paseo.workflow.id": "planner",
      "paseo.workflow.plan": "plan-1",
      "paseo.workflow.role": "plan-reviewer",
    },
  });
  expect(f.prompts[0].text).toContain("Keep the user in control");
  expect(f.prompts[0].text).toContain("Build the requested feature");
  expect(f.prompts[0].text).toContain("Exact (c) plan");
  expect(f.decisions).toEqual(["permission-1"]);
  expect(await new WorkflowController(f.port).review(plan, "automatic")).toEqual({
    agentId: "child-1",
  });
  expect(f.launches).toHaveLength(1);
});

test("review objections request a new append-only plan and allow only one further manual review", async () => {
  const f = fixture();
  const controller = new WorkflowController(f.port);
  await controller.review(plan, "automatic");
  await controller.finished("child-1", "Missing rollback validation");
  expect(f.prompts[1]).toMatchObject({ agentId: "planner" });
  expect(f.prompts[1].text).toContain("Missing rollback validation");
  expect(f.prompts[1].text).toContain("new plan");
  const nextPlan = {
    ...plan,
    callId: "plan-2",
    permissionRequestId: "permission-2",
    text: "Revised plan",
  };
  f.agents.get("planner")!.pendingPermissions = [
    {
      id: "permission-2",
      kind: "plan",
      sourcePlanCallId: "plan-2",
      input: { plan: "Revised plan" },
    },
  ];
  await expect(controller.review(nextPlan, "automatic")).rejects.toThrow("already been used");
  await controller.review(nextPlan, "manual");
  await controller.finished("child-2", "Looks good");
  const lastPlan = { ...plan, callId: "plan-3", permissionRequestId: "permission-3" };
  f.agents.get("planner")!.pendingPermissions = [
    { id: "permission-3", kind: "plan", sourcePlanCallId: "plan-3", input: { plan: plan.text } },
  ];
  await expect(controller.review(lastPlan, "manual")).rejects.toThrow("already been used");
  expect(f.launches).toHaveLength(2);
  const saved = await f.port.read();
  expect(saved.workflows.planner.plans["plan-1"].context.text).toBe("Exact (c) plan");
  await new WorkflowController(f.port).finished("child-1", "Late duplicate");
  expect(f.prompts).toHaveLength(4);
});
