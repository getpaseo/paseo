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
    executionSettings: async () => ({ modes: [], features: [] }),
    agent: async (id) => {
      const value = agents.get(id);
      if (!value) throw new Error("Unknown agent");
      return value;
    },
    workspace: async () => ({ cwd: "/workspace", intent: "Keep the user in control" }),
    timeline: async (id) => [
      { type: "user_message", text: "Build the requested feature" },
      {
        type: "tool_call",
        callId: agents.get(id)?.pendingPermissions[0]?.sourcePlanCallId ?? "plan-1",
        name: "Plan",
        status: "running",
        error: null,
        detail: {
          type: "plan",
          text: String(agents.get(id)?.pendingPermissions[0]?.input?.plan ?? "Exact (c) plan"),
        },
      },
    ],
    turn: async () => null,
    git: async () => ({
      startHead: "abc123",
      targetBase: "target-base",
      branch: "feature",
      dirty: " M existing.ts",
    }),
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
    revise: async (context, text, messageId) => {
      prompts.push({ agentId: context.agentId, text, messageId });
      return true;
    },
    respond: async (agentId, requestId) => {
      decisions.push(requestId);
      agents.get(agentId)!.pendingPermissions = [];
    },
    claimReview: async () => {},
    ensurePlanPermission: async () => {
      throw new Error("Unexpected synthetic permission");
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

async function preparedHandoff(
  controller: WorkflowController,
  _f: ReturnType<typeof fixture>,
  context: typeof plan,
) {
  return controller.handoff(context, "paseo-workflow-executor-standard");
}

test("handoff requires an explicit available profile and never classifies", async () => {
  const f = fixture();
  const controller = new WorkflowController(f.port);
  await expect(controller.handoff(plan)).rejects.toThrow("Choose an agent profile");
  await expect(controller.prepareHandoff(plan)).rejects.toThrow("Choose an agent profile");
  await expect(controller.enqueueHandoff(plan)).rejects.toThrow("Choose an agent profile");
  await expect(controller.handoff(plan, "deleted-profile")).rejects.toThrow("no longer available");
  expect(f.port).not.toHaveProperty("classify");
  expect(f.launches).toEqual([]);
  expect(f.decisions).toEqual([]);
});

test("status exposes the current plan and ordered profiles without preparing handoff", async () => {
  const f = fixture();
  const controller = new WorkflowController(f.port);
  expect(await controller.status("planner", "workspace")).toMatchObject({
    plan,
    profiles: profiles.map(({ id, name }) => ({ id, name })),
  });
  f.port.profiles = async () => [];
  expect(await controller.status("planner", "workspace")).toMatchObject({ plan, profiles: [] });
  f.agents.get("planner")!.pendingPermissions[0].input = { plan: "replacement" };
  const oldTimeline = await fixture().port.timeline("planner");
  f.port.timeline = async () => oldTimeline;
  expect(await controller.status("planner", "workspace")).toMatchObject({ plan: null });
  expect(f.port).not.toHaveProperty("classify");
});

test("handoff preserves a non-plan profile's settings to a root in the same workspace", async () => {
  const f = fixture();
  f.port.profiles = async () => [
    {
      id: "custom",
      name: "Custom",
      provider: "claude",
      model: "sonnet",
      modeId: "default",
      thinkingOptionId: "high",
      featureValues: { plan_mode: false },
      postApprovalModeId: "auto",
    },
  ];
  await new WorkflowController(f.port).handoff(plan, "custom");
  expect(f.launches).toEqual([
    {
      workspaceId: "workspace",
      launchProfileId: "custom",
      title: "Exact (c) plan",
      idempotencyKey: "workflow:planner:handoff:plan-1",
      config: {
        provider: "claude/sonnet",
        modeId: "default",
        thinkingOptionId: "high",
        featureValues: { plan_mode: false },
        writePolicy: "read_write",
      },
      labels: {
        "paseo.workflow.id": "planner",
        "paseo.workflow.plan": "plan-1",
        "paseo.workflow.role": "executor",
      },
    },
  ]);
  expect(f.port).not.toHaveProperty("classify");
});

test("duplicate profile handoffs for one plan reuse the same executor", async () => {
  const f = fixture();
  const controller = new WorkflowController(f.port);
  const results = await Promise.all([
    controller.handoff(plan, "paseo-workflow-executor-standard"),
    controller.handoff(plan, "paseo-workflow-executor-standard"),
  ]);

  expect(results).toEqual([{ agentId: "child-1" }, { agentId: "child-1" }]);
  expect(f.launches).toHaveLength(1);
  expect(f.launches[0]).toMatchObject({
    launchProfileId: "paseo-workflow-executor-standard",
    idempotencyKey: "workflow:planner:handoff:plan-1",
  });
});

test.each([
  {
    provider: "codex",
    modeId: "auto-review",
    defaultModeId: "auto-review",
    expected: "auto-review",
    toggle: true,
  },
  { provider: "claude", modeId: "plan", defaultModeId: "auto", expected: "auto" },
  { provider: "opencode", modeId: "plan", defaultModeId: "build", expected: "build" },
  {
    provider: "custom-acp",
    modeId: "https://agentclientprotocol.com/protocol/session-modes#plan",
    defaultModeId: "agent",
    expected: "agent",
  },
])("handoff disables Plan for $provider and preserves the saved profile", async (entry) => {
  const f = fixture();
  const profile = {
    id: "custom",
    name: "Custom",
    provider: entry.provider,
    model: "chosen-model",
    modeId: entry.modeId,
    thinkingOptionId: "high",
    featureValues: { ...(entry.toggle ? { plan_mode: true } : {}), fast_mode: true },
    postApprovalModeId: "unchanged",
  };
  const before = structuredClone(profile);
  f.port.profiles = async () => [profile];
  f.port.executionSettings = async () => ({
    defaultModeId: entry.defaultModeId,
    modes: [
      { id: entry.modeId, label: "Selected", colorTier: entry.toggle ? "moderate" : "planning" },
      { id: entry.expected, label: "Execution", colorTier: "moderate" },
    ],
    features: entry.toggle ? [{ type: "toggle", id: "plan_mode", label: "Plan", value: true }] : [],
  });
  const result = await new WorkflowController(f.port).handoff(plan, profile.id);
  expect(f.launches[0].config).toEqual({
    provider: `${entry.provider}/chosen-model`,
    modeId: entry.expected,
    thinkingOptionId: "high",
    featureValues: { ...(entry.toggle ? { plan_mode: false } : {}), fast_mode: true },
    writePolicy: "read_write",
  });
  expect(profile).toEqual(before);
  f.port.executionSettings = async () => {
    throw new Error("Must not reconfigure an existing agent");
  };
  expect(await new WorkflowController(f.port).handoff(plan, profile.id)).toEqual(result);
  expect(f.launches).toHaveLength(1);
});

test.each([
  { modeId: "execute", isUnattended: false },
  { modeId: "full", isUnattended: true },
])(
  "handoff preserves an already non-plan $modeId mode even when the default is Plan",
  async ({ modeId, isUnattended }) => {
    const f = fixture();
    const profile = { id: "custom", name: "Custom", provider: "custom-acp", modeId };
    f.port.profiles = async () => [profile];
    f.port.executionSettings = async () => ({
      defaultModeId: "plan",
      features: [],
      modes: [
        { id: "plan", label: "Plan", colorTier: "planning" },
        { id: modeId, label: "Chosen", isUnattended },
      ],
    });
    await new WorkflowController(f.port).handoff(plan, "custom");
    expect(f.launches[0].config.modeId).toBe(modeId);
  },
);

test("provider discovery failure leaves the source plan available", async () => {
  const f = fixture();
  f.port.executionSettings = async () => {
    throw new Error("Provider discovery failed");
  };
  const controller = new WorkflowController(f.port);
  await expect(controller.handoff(plan, profiles[0].id)).rejects.toThrow(
    "Provider discovery failed",
  );
  expect(f.decisions).toEqual([]);
  expect(f.launches).toEqual([]);
  expect(await controller.status("planner", "workspace")).toMatchObject({ plan, handoff: null });
});

test("handoff chooses a safe non-plan mode when the default is Plan", async () => {
  const f = fixture();
  f.port.profiles = async () => [
    { id: "custom", name: "Custom", provider: "custom-acp", modeId: "plan" },
  ];
  f.port.executionSettings = async () => ({
    defaultModeId: "plan",
    features: [],
    modes: [
      { id: "plan", label: "Plan", colorTier: "planning" },
      { id: "full", label: "Full", isUnattended: true },
      { id: "dangerous", label: "Dangerous", colorTier: "dangerous" },
      { id: "execute", label: "Execute", colorTier: "moderate" },
    ],
  });
  await new WorkflowController(f.port).handoff(plan, "custom");
  expect(f.launches[0].config.modeId).toBe("execute");
});

test("handoff resolves an implicit mode when the provider has no default", async () => {
  const f = fixture();
  f.port.profiles = async () => [{ id: "custom", name: "Custom", provider: "opencode" }];
  f.port.executionSettings = async () => ({
    defaultModeId: null,
    features: [],
    modes: [
      { id: "planning-agent", label: "Planner", colorTier: "planning" },
      { id: "build", label: "Build" },
    ],
  });
  await new WorkflowController(f.port).handoff(plan, "custom");
  expect(f.launches[0].config.modeId).toBe("build");
});

test("unresolvable execution leaves the source plan available without a recipient", async () => {
  const f = fixture();
  f.port.profiles = async () => [{ id: "custom", name: "Custom", provider: "custom-acp" }];
  f.port.executionSettings = async () => ({
    defaultModeId: "plan",
    features: [],
    modes: [
      { id: "plan", label: "Plan", colorTier: "planning" },
      { id: "full", label: "Full", isUnattended: true },
    ],
  });
  const controller = new WorkflowController(f.port);
  await expect(controller.handoff(plan, "custom")).rejects.toThrow("non-plan execution mode");
  expect(f.decisions).toEqual([]);
  expect(f.launches).toEqual([]);
  expect(await controller.status("planner", "workspace")).toMatchObject({ plan, handoff: null });
});

test("legacy queued routing stays readable and cannot launch without an explicit profile", async () => {
  const f = fixture();
  const controller = new WorkflowController(f.port);
  await controller.planRequested(plan, false);
  const state = await f.port.read();
  const saved = state.workflows.planner.plans[plan.callId];
  saved.handoffRequested = true;
  saved.routing = { attempt: 1, phase: "running", promptStarted: true };
  state.workflows.planner.preparedPlanId = plan.callId;
  await f.port.write(state);
  expect(await new WorkflowController(f.port).status("planner", "workspace")).toMatchObject({
    plan,
  });
  await expect(new WorkflowController(f.port).handoff(plan)).rejects.toThrow(
    "Choose an agent profile",
  );
  expect(f.port).not.toHaveProperty("classify");
  expect(f.launches).toEqual([]);
  expect(f.decisions).toEqual([]);
});

test("status captures an idle structured plan's canonical permission for explicit handoff", async () => {
  const f = fixture();
  const agent = f.agents.get("planner")!;
  agent.pendingPermissions = [];
  agent.status = "idle";
  const timeline = await f.port.timeline("planner");
  const item = timeline[1];
  if (item.type !== "tool_call") throw new Error("Expected plan");
  item.status = "completed";
  f.port.timeline = async () => timeline;
  let ensures = 0;
  f.port.ensurePlanPermission = async (context) => {
    expect(context).toEqual({
      workspaceId: plan.workspaceId,
      agentId: plan.agentId,
      callId: plan.callId,
      text: plan.text,
    });
    ensures++;
    const permission = {
      id: "synthetic-permission",
      provider: "codex" as const,
      name: "Plan",
      kind: "plan" as const,
      sourcePlanCallId: plan.callId,
      input: { plan: plan.text },
    };
    agent.pendingPermissions = [permission];
    return permission;
  };
  const controller = new WorkflowController(f.port);
  const captured = { ...plan, permissionRequestId: "synthetic-permission" };
  expect((await controller.status("planner", "workspace")).plan).toEqual(captured);
  expect((await controller.status("planner", "workspace")).plan).toEqual(captured);
  expect(ensures).toBe(1);
  await expect(controller.handoff(captured, "paseo-workflow-executor-standard")).resolves.toEqual({
    agentId: "child-1",
  });
  expect(f.decisions).toEqual(["synthetic-permission"]);
  expect(f.launches).toHaveLength(1);
});

test("a closed transfer without an executor waits for a fresh profile choice and saves it", async () => {
  const f = fixture();
  const timeline = await f.port.timeline("planner");
  f.port.timeline = async () => timeline;
  const respond = f.port.respond;
  f.port.respond = async (id, requestId, resolution) => {
    await respond(id, requestId, resolution);
    const item = timeline[1];
    if (item.type !== "tool_call") throw new Error("Expected plan");
    item.status = "completed";
    item.metadata = { approved: false, resolution };
  };
  const create = f.port.create;
  f.port.create = async () => {
    throw new Error("Spawn failed");
  };
  await expect(preparedHandoff(new WorkflowController(f.port), f, plan)).rejects.toThrow(
    "Spawn failed",
  );
  const controller = new WorkflowController(f.port);
  expect((await controller.status("planner", "workspace")).plan).toEqual(plan);
  expect(f.launches).toEqual([]);
  await expect(controller.handoff(plan)).rejects.toThrow("Choose an agent profile");
  f.port.create = create;
  await controller.handoff(plan, "paseo-workflow-executor-advanced");
  expect(f.launches[0].launchProfileId).toBe("paseo-workflow-executor-advanced");
  expect((await f.port.read()).workflows.planner.plans[plan.callId].handoff).toMatchObject({
    profileId: "paseo-workflow-executor-advanced",
    agentId: "child-1",
    phase: "running",
  });
  expect(f.decisions).toEqual([plan.permissionRequestId]);
});

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

test("an executor's question does not start final review without a reviewable delta", async () => {
  const f = fixture();
  const completedDiff = f.port.diff;
  f.port.diff = async () => ({ head: "abc123", text: "", dirtyFiles: [], untrackedFiles: [] });
  const controller = new WorkflowController(f.port);

  await preparedHandoff(controller, f, plan);
  await controller.finished("child-1", "Which behavior do you prefer?");
  expect(f.launches).toHaveLength(1);
  f.port.diff = completedDiff;
  await controller.finished("child-1", "Implemented and committed");
  expect(f.launches).toHaveLength(2);
});

test("final review audits an uncommitted local result without requesting a commit", async () => {
  const f = fixture();
  f.port.git = async () => ({
    startHead: "abc123",
    targetBase: "abc123",
    branch: "feature",
    dirty: "",
  });
  f.port.diff = async () => ({
    head: "abc123",
    text: "diff --git a/feature.ts b/feature.ts",
    dirtyFiles: ["feature.ts"],
    untrackedFiles: [],
  });
  f.port.commitCount = async () => 0;
  const controller = new WorkflowController(f.port);
  await preparedHandoff(controller, f, plan);
  await controller.finished("child-1", "Validated locally; no commit authorized.");
  expect(f.launches).toHaveLength(2);
  await controller.finished("child-2", '{"classification":"SIMPLE"}');
  await controller.finished("child-3", '{"findings":[]}');
  const saved = (await f.port.read()).workflows.planner.plans[plan.callId];
  expect(saved.verification).toBeUndefined();
  expect(saved.final?.phase).toBe("verification_required");
  expect(f.prompts.at(-1)?.text).toContain("do not edit or commit");
  expect(f.prompts.some(({ text }) => text.includes("commit your own changes"))).toBe(false);
});

test("unrelated tool approvals never select a workflow plan or start final review", async () => {
  const f = fixture();
  const controller = new WorkflowController(f.port);
  await controller.planRequested(plan, false);
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
    await preparedHandoff(controller, f, plan);
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
  f.port.git = async () => ({
    startHead: "abc123",
    targetBase: "target",
    branch: "feature",
    dirty: "",
  });
  f.port.diff = async () => ({
    head: "functional-commit",
    text: "functional diff",
    dirtyFiles: [],
    untrackedFiles: [],
  });
  const controller = new WorkflowController(f.port);

  await preparedHandoff(controller, f, plan);
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

  await preparedHandoff(controller, f, plan);
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
  "uncommitted",
  "uncommitted-concurrent-file",
])("correction evidence stays bounded (%s)", async (scenario) => {
  const f = fixture();
  f.port.git = async () => ({
    startHead: "abc123",
    targetBase: "target",
    branch: "feature",
    dirty: "",
  });
  f.port.diff = async () => ({
    head: "functional-commit",
    text: "functional diff",
    dirtyFiles: [],
    untrackedFiles: [],
  });
  const controller = new WorkflowController(f.port);

  await preparedHandoff(controller, f, plan);
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
  const remainingFiles = scenario.startsWith("uncommitted") ? ["feature.ts"] : [];
  if (scenario === "uncommitted-concurrent-file") remainingFiles.push("other.ts");
  f.port.diff = async () => ({
    head: scenario.startsWith("uncommitted") ? "functional-commit" : "correction-commit",
    text: "corrected delta",
    dirtyFiles: remainingFiles,
    untrackedFiles: [],
  });
  f.port.commitCount = async () => (scenario === "extra-commit" ? 2 : 1);
  await controller.finished(
    "child-2",
    scenario.startsWith("uncommitted") ? "Validated locally; commit not authorized" : "Committed",
  );
  expect((await f.port.read()).workflows.planner.plans["plan-1"].final?.phase).toBe(
    scenario === "extra-commit" || scenario === "uncommitted-concurrent-file"
      ? "verification_required"
      : "complete",
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

test("Router refreshes clarifications after an early status read without recapturing git", async () => {
  const f = fixture();
  f.agents.set("router", {
    id: "router",
    workspaceId: "workspace",
    launchProfileId: "paseo-workflow-router",
    labels: {},
    pendingPermissions: [],
  });
  let timeline = [{ type: "user_message" as const, text: "Build a dashboard" }];
  f.port.timeline = async () => timeline;
  let gitReads = 0;
  f.port.git = async () => ({
    startHead: `base-${++gitReads}`,
    targetBase: "target-base",
    branch: "feature",
    dirty: "",
  });
  const controller = new WorkflowController(f.port);
  await controller.status("router", "workspace");
  timeline = [
    ...timeline,
    { type: "assistant_message" as const, text: "Which storage?" },
    {
      type: "user_message" as const,
      text: "Use SQLite and preserve the existing settings screen.",
    },
  ];
  await controller.finished(
    "router",
    JSON.stringify({ ready: true, recommendation: "standard", constraints: [], assumptions: [] }),
  );
  expect(f.prompts[0]?.text).toContain("Build a dashboard");
  expect(f.prompts[0]?.text).toContain("Use SQLite and preserve the existing settings screen.");
  expect((await f.port.read()).workflows.router.git.startHead).toBe("base-1");
  expect(gitReads).toBe(1);
});

test("reconcile recovers the latest canonically approved planner plan missed during reload", async () => {
  const f = fixture();
  f.agents.set("router", {
    id: "router",
    workspaceId: "workspace",
    launchProfileId: "paseo-workflow-router",
    labels: {},
    pendingPermissions: [],
  });
  let plannerTimeline: Awaited<ReturnType<WorkflowPort["timeline"]>> = [];
  f.port.timeline = async (id) =>
    id === "router" ? [{ type: "user_message", text: "Build the dashboard" }] : plannerTimeline;
  const controller = new WorkflowController(f.port);
  await controller.finished(
    "router",
    JSON.stringify({ ready: true, recommendation: "standard", constraints: [], assumptions: [] }),
  );
  const knownPlan = {
    workspaceId: "workspace",
    agentId: "child-1",
    permissionRequestId: "known-permission",
    callId: "known-plan",
    text: "Earlier plan",
  };
  f.agents.get("child-1")!.pendingPermissions = [
    {
      id: knownPlan.permissionRequestId,
      kind: "plan",
      sourcePlanCallId: knownPlan.callId,
      input: { plan: knownPlan.text },
    },
  ];
  plannerTimeline = [
    {
      type: "tool_call",
      callId: knownPlan.callId,
      name: "Plan",
      status: "running",
      error: null,
      detail: { type: "plan", text: knownPlan.text },
    },
  ];
  await controller.planRequested(knownPlan, false);
  plannerTimeline = [
    { type: "user_message", text: "Plan the request" },
    {
      type: "tool_call",
      callId: "late-plan",
      name: "Plan",
      status: "completed",
      error: null,
      detail: { type: "plan", text: "Late approved plan" },
      metadata: { approved: false, resolution: { behavior: "deny" } },
    },
  ];
  await new WorkflowController(f.port).status("router", "workspace");
  expect((await f.port.read()).workflows.router.plans["late-plan"]).toBeUndefined();
  plannerTimeline = [
    { type: "user_message", text: "Plan the request" },
    {
      type: "tool_call",
      callId: knownPlan.callId,
      name: "Plan",
      status: "completed",
      error: null,
      detail: { type: "plan", text: knownPlan.text },
      metadata: { approved: true, resolution: { behavior: "allow" } },
    },
    {
      type: "tool_call",
      callId: "late-plan",
      name: "Plan",
      status: "completed",
      error: null,
      detail: { type: "plan", text: "Late approved plan" },
      metadata: { approved: true, resolution: { behavior: "allow" } },
    },
  ];
  f.port.turn = async (_id, _turnId, _expectedMessageId, approvedPlanCallId) =>
    approvedPlanCallId === "late-plan"
      ? {
          key: "late-implementation",
          items: [{ type: "assistant_message", text: "Implemented and committed" }],
        }
      : null;
  await new WorkflowController(f.port).status("router", "workspace");
  await new WorkflowController(f.port).status("router", "workspace");
  const recovered = (await f.port.read()).workflows.router;
  expect(recovered.git.startHead).toBe("abc123");
  expect(recovered.activePlanId).toBe("late-plan");
  expect(recovered.plans["known-plan"]?.approved).toBe(true);
  expect(recovered.plans["late-plan"]).toMatchObject({
    approved: true,
    context: {
      workspaceId: "workspace",
      agentId: "child-1",
      callId: "late-plan",
      text: "Late approved plan",
    },
  });
  expect(recovered.plans["late-plan"]?.context.permissionRequestId).toBeUndefined();
  expect(recovered.plans["late-plan"]?.final?.phase).toBe("classifying");
  expect(
    f.launches.filter((launch) => launch.launchProfileId?.endsWith("final-review")),
  ).toHaveLength(1);
});

test("handoff does not recover closing from a non-workflow denial", async () => {
  const f = fixture();
  let timeline = await f.port.timeline("planner");
  f.port.timeline = async () => timeline;
  f.port.respond = async (_agentId, _requestId, response) => {
    f.agents.get("planner")!.pendingPermissions = [];
    timeline = [
      {
        type: "tool_call",
        callId: plan.callId,
        name: "Plan",
        status: "completed",
        error: null,
        detail: { type: "plan", text: plan.text },
        metadata: {
          approved: false,
          resolution: { ...response, message: "Different denial" },
        },
      },
    ];
    throw new Error("ACK lost after consumption");
  };

  await expect(preparedHandoff(new WorkflowController(f.port), f, plan)).rejects.toThrow(
    "ACK lost",
  );
  await expect(preparedHandoff(new WorkflowController(f.port), f, plan)).rejects.toThrow(
    "no longer pending",
  );
  expect(f.launches).toEqual([]);
});

test("handoff revalidates the persisted plan before launching the executor", async () => {
  const f = fixture();
  let timeline = await f.port.timeline("planner");
  f.port.timeline = async () => timeline;
  f.port.respond = async (_agentId, _requestId, response) => {
    f.agents.get("planner")!.pendingPermissions = [];
    timeline = [
      {
        type: "tool_call",
        callId: plan.callId,
        name: "Plan",
        status: "completed",
        error: null,
        detail: { type: "plan", text: plan.text },
        metadata: { approved: false, resolution: response },
      },
    ];
  };
  const create = f.port.create;
  f.port.create = async (input) => {
    if (input.idempotencyKey.includes("classifier")) return create(input);
    throw new Error("Spawn unavailable after closing");
  };

  await expect(preparedHandoff(new WorkflowController(f.port), f, plan)).rejects.toThrow(
    "Spawn unavailable",
  );
  timeline = [
    ...timeline,
    {
      type: "tool_call",
      callId: "plan-2",
      name: "Plan",
      status: "running",
      error: null,
      detail: { type: "plan", text: "Newer plan" },
    },
  ];
  f.port.create = create;
  await new WorkflowController(f.port).status("planner", "workspace");
  await expect(preparedHandoff(new WorkflowController(f.port), f, plan)).rejects.toThrow(
    "superseded",
  );
  expect(f.launches).toEqual([]);
});

test("handoff does not resume an old denial after a newer unresolved plan", async () => {
  const f = fixture();
  let timeline = await f.port.timeline("planner");
  f.port.timeline = async () => timeline;
  f.port.respond = async (_agentId, _requestId, response) => {
    f.agents.get("planner")!.pendingPermissions = [];
    timeline = [
      {
        type: "tool_call",
        callId: plan.callId,
        name: "Plan",
        status: "completed",
        error: null,
        detail: { type: "plan", text: plan.text },
        metadata: { approved: false, resolution: response },
      },
      {
        type: "tool_call",
        callId: "plan-2",
        name: "Plan",
        status: "running",
        error: null,
        detail: { type: "plan", text: "Newer plan" },
      },
    ];
    throw new Error("ACK lost after consumption");
  };

  await expect(preparedHandoff(new WorkflowController(f.port), f, plan)).rejects.toThrow(
    "ACK lost",
  );
  await new WorkflowController(f.port).status("planner", "workspace");
  expect(f.launches).toEqual([]);
});

test.each([
  ["a newer call", "plan-2", "Newer plan"],
  ["changed text under the same call", plan.callId, "Changed current plan"],
] as const)(
  "handoff does not resume a persisted closed operation after %s",
  async (_, callId, text) => {
    const f = fixture();
    let timeline = await f.port.timeline("planner");
    f.port.timeline = async () => timeline;
    f.port.respond = async (_agentId, _requestId, response) => {
      f.agents.get("planner")!.pendingPermissions = [];
      timeline = [
        {
          type: "tool_call",
          callId: plan.callId,
          name: "Plan",
          status: "completed",
          error: null,
          detail: { type: "plan", text: plan.text },
          metadata: { approved: false, resolution: response },
        },
      ];
    };
    const create = f.port.create;
    f.port.create = async (input) => {
      if (input.idempotencyKey.includes("classifier")) return create(input);
      throw new Error("Spawn unavailable after closing");
    };

    await expect(preparedHandoff(new WorkflowController(f.port), f, plan)).rejects.toThrow(
      "Spawn unavailable",
    );
    timeline = [
      ...timeline,
      {
        type: "tool_call",
        callId,
        name: "Plan",
        status: "running",
        error: null,
        detail: { type: "plan", text },
      },
    ];
    f.port.create = create;
    await new WorkflowController(f.port).status("planner", "workspace");
    await expect(preparedHandoff(new WorkflowController(f.port), f, plan)).rejects.toThrow(
      "superseded",
    );
    expect(f.launches).toEqual([]);
  },
);

test.each(["review", "handoff"] as const)(
  "%s resumes a persisted closed operation without answering the permission twice",
  async (action) => {
    const f = fixture();
    if (action === "handoff") {
      let timeline = await f.port.timeline("planner");
      const respond = f.port.respond;
      f.port.timeline = async () => timeline;
      f.port.respond = async (agentId, requestId, response) => {
        await respond(agentId, requestId, response);
        timeline = [
          {
            type: "tool_call",
            callId: plan.callId,
            name: "Plan",
            status: "completed",
            error: null,
            detail: { type: "plan", text: plan.text },
            metadata: { approved: false, resolution: response },
          },
        ];
      };
    }
    const create = f.port.create;
    f.port.create = async (input) => {
      if (input.idempotencyKey.includes("classifier")) return create(input);
      throw new Error("Temporary spawn failure");
    };
    const invoke = (controller: WorkflowController) =>
      action === "review"
        ? controller.review(plan, "manual")
        : preparedHandoff(controller, f, plan);

    await expect(invoke(new WorkflowController(f.port))).rejects.toThrow("Temporary spawn failure");
    f.port.create = create;
    expect(await invoke(new WorkflowController(f.port))).toEqual({
      agentId: "child-1",
    });
    expect(f.decisions).toEqual(["permission-1"]);
    expect(f.launches).toHaveLength(1);
  },
);

test.each(["review", "handoff"] as const)(
  "%s resumes after the exact workflow denial was consumed but its acknowledgement was lost",
  async (action) => {
    const f = fixture();
    let timeline = await f.port.timeline("planner");
    f.port.timeline = async () => timeline;
    f.port.respond = async (_agentId, requestId, response) => {
      f.decisions.push(requestId);
      f.agents.get("planner")!.pendingPermissions = [];
      timeline = [
        { type: "user_message", text: "Build the requested feature" },
        {
          type: "tool_call",
          callId: plan.callId,
          name: "Plan",
          status: "completed",
          error: null,
          detail: { type: "plan", text: plan.text },
          metadata: { approved: false, resolution: response },
        },
      ];
      throw new Error("ACK lost after consumption");
    };
    const invoke = (controller: WorkflowController) =>
      action === "review"
        ? controller.review(plan, "manual")
        : preparedHandoff(controller, f, plan);

    await expect(invoke(new WorkflowController(f.port))).rejects.toThrow("ACK lost");
    f.port.respond = async () => {
      throw new Error("The denial must not be replayed");
    };
    if (action === "review") {
      f.port.turn = async (id) =>
        id === "child-1"
          ? { key: "review-finished", items: [{ type: "assistant_message", text: "Revise this" }] }
          : null;
    }
    await new WorkflowController(f.port).status("planner", "workspace");
    await expect(invoke(new WorkflowController(f.port))).resolves.toEqual({
      agentId: "child-1",
    });
    expect(f.decisions).toEqual(["permission-1"]);
    expect(f.launches).toHaveLength(1);
    expect(f.prompts).toHaveLength(action === "review" ? 2 : 1);
    const saved = (await f.port.read()).workflows.planner.plans[plan.callId];
    expect(action === "review" ? saved.review?.phase : saved.handoff?.phase).toBe(
      action === "review" ? "complete" : "running",
    );
  },
);

test("handoff delivers only the exact plan and original git context", async () => {
  const f = fixture();
  const context = { ...plan, text: "  Execute this plan.\nNo commit or push authorized.\n" };
  f.agents.get("planner")!.pendingPermissions[0].input = { plan: context.text };

  const controller = new WorkflowController(f.port);
  const results = await Promise.all([
    preparedHandoff(controller, f, context),
    preparedHandoff(controller, f, context),
  ]);
  expect(results).toEqual([{ agentId: "child-1" }, { agentId: "child-1" }]);
  expect(f.launches).toHaveLength(1);
  expect(f.launches[0]).toMatchObject({
    workspaceId: "workspace",
    title: "Execute this plan.",
    idempotencyKey: "workflow:planner:handoff:plan-1",
    config: {
      provider: "codex/gpt-5.6-sol",
      modeId: "auto",
      thinkingOptionId: "medium",
      writePolicy: "read_write",
    },
    labels: {
      "paseo.workflow.id": "planner",
      "paseo.workflow.plan": "plan-1",
      "paseo.workflow.role": "executor",
    },
  });
  expect(f.launches[0].launchProfileId).toBe("paseo-workflow-executor-standard");
  expect(f.prompts[0].text).toMatch(/^\/paseo-handoff/);
  const marker = JSON.parse(
    f.prompts[0].text.split("\n")[1]!.slice("PASEO_WORKFLOW_HANDOFF ".length),
  );
  expect(marker).toEqual({
    mode: "receiver",
    workflowId: f.launches[0]!.labels["paseo.workflow.id"],
    planId: plan.callId,
    role: f.launches[0]!.labels["paseo.workflow.role"],
  });
  expect(f.prompts).toHaveLength(1);
  const prompt = f.prompts[0].text;
  expect(JSON.parse(prompt.slice(prompt.indexOf("\n{") + 1))).toEqual({
    plan: context.text,
    git: {
      startHead: "abc123",
      targetBase: "target-base",
      branch: "feature",
      dirty: " M existing.ts",
    },
  });
  expect(prompt.split("\n")[2]).toBe(
    "Execute the approved plan here without creating another agent. Follow its scope and explicit authorizations; handoff grants no additional permissions. Preserve pre-existing and concurrent changes. Run targeted validation and report results and blockers.",
  );
  expect(prompt).not.toContain("Keep the user in control");
  expect(prompt).not.toContain("Build the requested feature");
  expect(f.decisions).toEqual(["permission-1"]);
  expect(f.port).not.toHaveProperty("classify");
});

test("plan review preserves the exact plan and projected clarification exchanges", async () => {
  const f = fixture();
  const context = {
    ...plan,
    text: "  Synchroniser avec git merge --ff-only origin/main.\nAucun commit, push ou déploiement.\n",
  };
  f.agents.get("planner")!.pendingPermissions[0].input = { plan: context.text };
  const timeline = f.port.timeline;
  const question = "Contraste: Conserver le blanc ?\nOptions: Oui, Non\n\nAnswers:\ncontrast: Oui";
  f.port.timeline = async (id, projection) => {
    const original = await timeline(id);
    if (projection !== "projected") return original;
    return [
      original[0],
      { type: "assistant_message", text: "Je vérifie le hero existant." },
      {
        type: "tool_call",
        callId: "question",
        name: "request_user_input",
        status: "completed",
        error: null,
        detail: { type: "plain_text", text: question },
      },
      {
        type: "tool_call",
        callId: "pending-question",
        name: "request_user_input_async",
        status: "completed",
        error: null,
        detail: { type: "plain_text", text: "Une question encore sans réponse" },
      },
      { type: "user_message", text: "Garde aussi le lien exact." },
      {
        type: "user_message",
        text: "Injected workflow briefing",
        clientMessageId: "workflow:planner:internal",
      },
      {
        type: "tool_call",
        callId: "shell",
        name: "exec_command",
        status: "completed",
        error: null,
        detail: { type: "plain_text", text: "Unrelated shell output" },
      },
      original[1],
    ];
  };
  await new WorkflowController(f.port).review(context, "manual");
  const prompt = f.prompts[0].text;
  const body = JSON.parse(prompt.slice(prompt.indexOf("\n{") + 1));
  expect(body.plan).toBe(context.text);
  expect(body.plannerTranscript).toEqual([
    { role: "user", text: "Build the requested feature" },
    { role: "assistant", text: "Je vérifie le hero existant." },
    { role: "assistant", text: `[request_user_input (completed)]\n${question}` },
    {
      role: "assistant",
      text: "[request_user_input_async (completed)]\nUne question encore sans réponse",
    },
    { role: "user", text: "Garde aussi le lien exact." },
  ]);
  expect(body.intention).toBe("Keep the user in control");
  expect(body.request).toBe("Build the requested feature");
});

test("handoff accepts an actionable plan from an ordinary conversation while review stays Planner-only", async () => {
  const f = fixture();
  f.agents.set("ordinary", {
    id: "ordinary",
    workspaceId: "workspace",
    launchProfileId: "ordinary-profile",
    labels: {},
    pendingPermissions: [
      {
        id: "ordinary-permission",
        kind: "plan",
        sourcePlanCallId: "ordinary-plan",
        input: { plan: "Ordinary exact plan" },
      },
    ],
  });
  const ordinary = {
    workspaceId: "workspace",
    agentId: "ordinary",
    permissionRequestId: "ordinary-permission",
    callId: "ordinary-plan",
    text: "Ordinary exact plan",
  };
  const controller = new WorkflowController(f.port);

  expect((await controller.status(ordinary.agentId, ordinary.workspaceId)).plan).toEqual(ordinary);
  await expect(controller.review(ordinary, "manual")).rejects.toThrow("planner profile");

  await expect(preparedHandoff(controller, f, ordinary)).resolves.toEqual({
    agentId: "child-1",
  });
  expect(f.launches[0]).toMatchObject({
    workspaceId: "workspace",
    config: {
      provider: "codex/gpt-5.6-sol",
      thinkingOptionId: "medium",
      writePolicy: "read_write",
    },
  });
  expect(f.launches[0].launchProfileId).toBe("paseo-workflow-executor-standard");
});

test("an ordinary plan transfers without classification", async () => {
  const f = fixture();
  f.agents.set("ordinary", {
    id: "ordinary",
    workspaceId: "workspace",
    launchProfileId: "ordinary-profile",
    labels: {},
    pendingPermissions: [
      {
        id: "ordinary-permission",
        kind: "plan",
        sourcePlanCallId: "ordinary-plan",
        input: { plan: "Ordinary exact plan" },
      },
    ],
  });
  const ordinaryPlan = {
    workspaceId: "workspace",
    agentId: "ordinary",
    permissionRequestId: "ordinary-permission",
    callId: "ordinary-plan",
    text: "Ordinary exact plan",
  };

  const result = await preparedHandoff(new WorkflowController(f.port), f, ordinaryPlan);
  expect(result).toEqual({ agentId: "child-1" });
  expect(f.launches[0]).toMatchObject({
    workspaceId: "workspace",
    idempotencyKey: "workflow:ordinary:handoff:ordinary-plan",
    config: {
      provider: "codex/gpt-5.6-sol",
      thinkingOptionId: "medium",
      writePolicy: "read_write",
    },
    labels: { "paseo.workflow.role": "executor" },
  });
  expect(f.launches[0].launchProfileId).toBe("paseo-workflow-executor-standard");
  expect(f.prompts[0].agentId).toBe("child-1");
  expect(f.prompts[0].text).toMatch(/^\/paseo-handoff/);
  expect(f.prompts[0].messageId).toBe("workflow:ordinary:handoff:ordinary-plan:prompt");
  expect(f.decisions).toEqual(["ordinary-permission"]);
  expect(f.port).not.toHaveProperty("classify");
});

test("an uncertain handoff reuses the executor without sending its instruction again", async () => {
  const f = fixture();
  const controller = new WorkflowController(f.port);

  let sends = 0;
  f.port.send = async (_agentId, text) => {
    sends += 1;
    expect(text).toMatch(/^\/paseo-handoff/);
    if (sends === 1) throw new Error("agent_request_outcome_unknown");
  };
  await expect(preparedHandoff(controller, f, plan)).rejects.toThrow("outcome_unknown");
  expect((await f.port.read()).workflows.planner.plans[plan.callId].handoff).toMatchObject({
    phase: "outcome_unknown",
    agentId: "child-1",
  });
  await expect(preparedHandoff(new WorkflowController(f.port), f, plan)).resolves.toEqual({
    agentId: "child-1",
  });
  expect(sends).toBe(1);
  expect(f.launches).toHaveLength(1);
});

test("a rejected executor prompt requires explicit enqueue and reuses the closed handoff", async () => {
  const f = fixture();

  const timeline = await f.port.timeline("planner");
  f.port.timeline = async () => timeline;
  const respond = f.port.respond;
  f.port.respond = async (agentId, requestId, resolution) => {
    await respond(agentId, requestId, resolution);
    const item = timeline[1];
    if (item.type !== "tool_call") throw new Error("Expected plan");
    item.status = "completed";
    item.metadata = { approved: false, resolution };
  };
  const send = f.port.send;
  let rejected = false;
  f.port.send = async (id, text, messageId) => {
    if (id === "child-1" && !rejected) {
      rejected = true;
      throw new Error("agent_request_not_accepted");
    }
    await send(id, text, messageId);
  };
  const controller = new WorkflowController(f.port);
  await expect(preparedHandoff(controller, f, plan)).rejects.toThrow("agent_request_not_accepted");
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(await controller.status("planner", "workspace")).toMatchObject({
    handoff: { phase: "closed", agentId: "child-1" },
  });
  expect(f.prompts.filter((prompt) => prompt.agentId === "child-1")).toEqual([]);
  await Promise.all([preparedHandoff(controller, f, plan), preparedHandoff(controller, f, plan)]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(await controller.status("planner", "workspace")).toMatchObject({
    handoff: { phase: "running", agentId: "child-1" },
  });
  expect(f.launches).toHaveLength(1);
  expect(f.prompts.filter((prompt) => prompt.agentId === "child-1")).toHaveLength(1);
  expect(f.decisions).toEqual([plan.permissionRequestId]);
});

test("two concurrent handoff calls launch one executor", async () => {
  const f = fixture();

  const controller = new WorkflowController(f.port);
  const results = await Promise.all([
    preparedHandoff(controller, f, plan),
    preparedHandoff(controller, f, plan),
  ]);
  expect(results).toEqual([{ agentId: "child-1" }, { agentId: "child-1" }]);
  expect(f.launches).toHaveLength(1);
});

test("a persisted complete decision never classifies again", async () => {
  const f = fixture();

  await preparedHandoff(new WorkflowController(f.port), f, plan);
  expect(f.launches).toHaveLength(1);
  const state = await f.port.read();
  state.workflows.planner.plans["plan-1"].handoff!.phase = "outcome_unknown";
  state.workflows.planner.plans["plan-1"].handoff!.agentId = "child-1";
  await f.port.write(state);
  await expect(preparedHandoff(new WorkflowController(f.port), f, plan)).resolves.toEqual({
    agentId: "child-1",
  });
  expect(f.launches).toHaveLength(1);
});

test.each(["paseo-workflow-executor-standard", "paseo-workflow-router", "paseo-workflow-planner"])(
  "turnEnded starts final review for executor profile %s",
  async (selectedProfileId) => {
    const f = fixture();

    await new WorkflowController(f.port).handoff(plan, selectedProfileId);
    f.port.turn = async (id) =>
      id === "child-1"
        ? {
            key: "executor-done",
            items: [{ type: "assistant_message", text: "Implemented and committed" }],
          }
        : null;
    await new WorkflowController(f.port).turnEnded("child-1", "turn-1");
    expect(f.launches.at(-1)).toMatchObject({
      launchProfileId: "paseo-workflow-final-review",
      labels: {
        "paseo.workflow.id": "planner",
        "paseo.workflow.plan": "plan-1",
        "paseo.workflow.role": "final-review",
      },
    });
  },
);

test("deleted profiles and stale contexts reject before closing or launching", async () => {
  const f = fixture();
  const controller = new WorkflowController(f.port);
  f.removeProfile("paseo-workflow-executor-standard");
  await expect(preparedHandoff(controller, f, plan)).rejects.toThrow("no longer available");
  await expect(
    controller.handoff({ ...plan, workspaceId: "other" }, profiles[0].id),
  ).rejects.toThrow("workspace");
  await expect(controller.handoff({ ...plan, text: "stale" }, profiles[0].id)).rejects.toThrow(
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
  f.port.timeline = async () => [
    { type: "user_message", text: "Build the requested feature" },
    {
      type: "tool_call",
      callId: "plan-2",
      name: "Plan",
      status: "running",
      error: null,
      detail: { type: "plan", text: "Revised plan" },
    },
  ];
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
