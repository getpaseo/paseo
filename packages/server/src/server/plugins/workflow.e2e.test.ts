import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { settingsRpc } from "@getpaseo/plugin";
import { expect, test, vi } from "vitest";
import { profiles } from "../../../../../plugins/paseo-workflow/shared/profiles.js";
import { workflowSettings } from "../../../../../plugins/paseo-workflow/server/state.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import type {
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "../agent/agent-sdk-types.js";
import { AgentTurnNotAcceptedError } from "../agent/agent-sdk-types.js";
import { workflowNativeHistory } from "../test-utils/native-provider-history.js";
import { AgentRequests, AgentRequestRejectedError } from "../agent/requests/index.js";
import type { StoredAgentRecord } from "../agent/agent-storage.js";

function nextRoleFor(role: string) {
  return role === "router" ? "planner" : "final-review";
}

async function lifecycleFixture(
  options: {
    intent?: string;
    target?: boolean;
    providerHistory?: boolean;
    nativeHistory?: "claude" | "codex";
  } = {},
) {
  const directory = await mkdtemp(path.join(tmpdir(), "workflow-lifecycle-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
  git("init", "--quiet");
  git("config", "user.email", "workflow@example.invalid");
  git("config", "user.name", "Workflow Test");
  await writeFile(path.join(directory, "feature.txt"), "initial\n");
  git("add", "feature.txt");
  git("commit", "--quiet", "-m", "base");
  if (options.target !== false) {
    git("update-ref", "refs/remotes/origin/release", git("rev-parse", "HEAD"));
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/release");
  }
  const provider = createTestAgentClient("codex");
  const originalCreate = provider.createSession.bind(provider);
  const originalResume = provider.resumeSession.bind(provider);
  const originalCatalog = provider.fetchCatalog.bind(provider);
  provider.fetchCatalog = async (catalogOptions) => {
    const { modes } = await originalCatalog(catalogOptions);
    return {
      models: [
        {
          provider: "codex",
          id: "gpt-5.6-luna",
          label: "Luna",
          thinkingOptions: [{ id: "low", label: "Low" }],
        },
        {
          provider: "codex",
          id: "gpt-5.6-sol",
          label: "Sol",
          isDefault: true,
          thinkingOptions: [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
            { id: "high", label: "High" },
          ],
        },
        {
          provider: "codex",
          id: "gpt-6-astra",
          label: "Astra",
          thinkingOptions: [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
            { id: "high", label: "High" },
            { id: "xhigh", label: "Extra high" },
          ],
        },
      ],
      modes,
    };
  };
  const prompts: Array<{ role: string; text: string }> = [];
  const replies = new Map<string, string[]>();
  const holds = new Map<string, Promise<void>>();
  const failures = new Map<string, number>();
  const permissionFailures = new Map<string, number>();
  const sendFailures = new Map<string, "not-accepted" | "unknown">();
  const canceled = new Set<string>();
  const effects = new Map<string, (text: string) => Promise<void>>();
  const toolEvidence = new Map<string, string>();
  const reusedTurnIds = new Set<string>();
  const providerHistory = new Map<string, AgentStreamEvent[]>();
  const roleFor = (config: Partial<AgentSessionConfig>) =>
    /Your workflow role is ([\w-]+)/.exec(config.systemPrompt ?? "")?.[1] ?? "router";
  const wrapSession = (
    session: AgentSession,
    config: Partial<AgentSessionConfig>,
    owner: string | undefined,
    resumed = false,
  ) => {
    const role = roleFor(config);
    const history = providerHistory.get(owner!) ?? [];
    providerHistory.set(owner!, history);
    if (options.providerHistory)
      session.streamHistory = async function* () {
        yield* options.nativeHistory
          ? await workflowNativeHistory(history, options.nativeHistory)
          : history;
      };
    const describe = session.describePersistence.bind(session);
    session.describePersistence = () => {
      const handle = describe();
      // Mirror Codex's persisted policy/owner contract; the generic fake omits it.
      return handle
        ? {
            ...handle,
            metadata: { ...handle.metadata, writePolicy: config.writePolicy, agentId: owner },
          }
        : null;
    };
    const mapTurnId = (id: string) => {
      if (!reusedTurnIds.has(role) || resumed) return id;
      return role === "final-review" ? "fake-turn-1" : "fake-turn-0";
    };
    const respond = session.respondToPermission.bind(session);
    session.respondToPermission = async (...args) => {
      if (permissionFailures.get(role)) {
        permissionFailures.set(role, permissionFailures.get(role)! - 1);
        throw new Error("Requested deny failure");
      }
      return respond(...args);
    };
    const subscribe = session.subscribe.bind(session);
    session.subscribe = (subscriber) =>
      subscribe((event) => {
        if ("turnId" in event && event.turnId)
          event = { ...event, turnId: mapTurnId(event.turnId) };
        if (options.providerHistory && event.type === "timeline") history.push(event);
        if (event.type === "turn_started" && toolEvidence.has(role)) {
          const command = toolEvidence.get(role)!;
          toolEvidence.delete(role);
          subscriber({
            type: "timeline",
            provider: "codex",
            turnId: event.turnId,
            item: {
              type: "tool_call",
              callId: "old-validation",
              name: "shell",
              status: "completed",
              error: null,
              detail: { type: "shell", command, exitCode: 0 },
            },
          });
        }
        const result =
          event.type === "turn_completed" && canceled.has(role)
            ? {
                type: "turn_canceled" as const,
                provider: "codex",
                turnId: event.turnId,
                reason: "Canceled in provider",
              }
            : event;
        const held = holds.get(role);
        if (held) void held.then(() => subscriber(result));
        else subscriber(result);
      });
    const start = session.startTurn.bind(session);
    session.startTurn = async (input, runOptions) => {
      const text = typeof input === "string" ? input : JSON.stringify(input);
      const failure = sendFailures.get(role);
      sendFailures.delete(role);
      if (failure === "not-accepted")
        throw new AgentTurnNotAcceptedError("Requested prompt rejection before acceptance");
      prompts.push({ role, text });
      const submitted: Extract<AgentStreamEvent, { type: "timeline" }> = {
        type: "timeline",
        provider: "codex",
        item: {
          type: "user_message",
          text,
          clientMessageId: runOptions?.clientMessageId,
          ...(options.nativeHistory ? { messageId: `native-prompt-${history.length}` } : {}),
        },
      };
      if (options.providerHistory && !options.nativeHistory) history.push(submitted);
      await effects.get(role)?.(text);
      const result = await start(
        `Respond with exactly: ${replies.get(role)?.shift() ?? "Which constraint matters?"}`,
      );
      submitted.turnId = mapTurnId(result.turnId);
      if (options.nativeHistory) {
        // Native replay UUIDs originate in the actual live echo, not a host digest.
        (
          session as unknown as { notifySubscribers(event: AgentStreamEvent): void }
        ).notifySubscribers(submitted);
      }
      if (failure === "unknown") throw new Error("Acknowledgement lost after provider acceptance");
      return { turnId: mapTurnId(result.turnId) };
    };
    return session;
  };
  provider.createSession = async (config, context) => {
    const role = roleFor(config);
    if (failures.get(role)) {
      failures.set(role, failures.get(role)! - 1);
      throw new Error("Requested spawn failure");
    }
    return wrapSession(await originalCreate(config, context), config, context?.agentId);
  };
  provider.resumeSession = async (handle, config, context) =>
    wrapSession(
      await originalResume(handle, config, context),
      config ?? {},
      context?.agentId,
      true,
    );
  let daemon = await createTestPaseoDaemon({
    agentClients: { codex: provider },
    cleanup: !options.providerHistory,
  });
  let client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.8.0" });
  await client.connect();
  await client.patchDaemonConfig({
    pluginsEnabled: true,
    agentProfiles: profiles.map((profile) => Object.assign({}, profile, { modeId: "full-access" })),
  });
  await client.installDirectoryPlugin(path.resolve("plugins/paseo-workflow"));
  const workspace = (
    await client.createWorkspace({
      source: { kind: "directory", path: directory },
      intent: options.intent,
    })
  ).workspace!;
  const rpc = settingsRpc("workflows");
  const read = async () => {
    const response = rpc.read.output.parse(
      await client.invokePluginRpc("paseo-workflow", rpc.read.name, {}),
    );
    return { ...response, values: workflowSettings.schema.parse(response.values) };
  };
  const agents = (role: string) =>
    daemon.daemon.agentManager
      .listAgents()
      .filter((agent) => agent.launchProfileId === `paseo-workflow-${role}`);
  const labelled = (role: string) =>
    daemon.daemon.agentManager
      .listAgents()
      .filter((agent) => agent.labels["paseo.workflow.role"] === role);
  return {
    directory,
    git,
    get daemon() {
      return daemon;
    },
    get client() {
      return client;
    },
    workspace,
    read,
    agents,
    labelled,
    prompts,
    replies,
    holds,
    failures,
    permissionFailures,
    sendFailures,
    canceled,
    effects,
    toolEvidence,
    reusedTurnIds,
    providerHistory,
    restart: async (legacyAgentId?: string) => {
      if (!options.providerHistory) throw new Error("Restart fixture requires provider history");
      const persisted = (await client.getDaemonConfig()).config;
      await client.close();
      await daemon.close();
      if (legacyAgentId) {
        const record = (await daemon.daemon.agentStorage.get(legacyAgentId))!;
        await daemon.daemon.agentStorage.upsert({
          ...record,
          lastCompletedTurnEvidence: undefined,
        });
      }
      daemon = await createTestPaseoDaemon({
        agentClients: { codex: provider },
        paseoHomeRoot: path.dirname(daemon.paseoHome),
        staticDir: daemon.staticDir,
        cleanup: false,
        pluginsEnabled: persisted.pluginsEnabled,
        plugins: persisted.plugins,
        agentProfiles: persisted.agentProfiles,
      });
      client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.8.0" });
      await client.connect();
    },
    write: async (values: ReturnType<typeof workflowSettings.schema.parse>) => {
      const state = await read();
      await client.invokePluginRpc("paseo-workflow", rpc.write.name, {
        revision: state.revision,
        values,
      });
    },
    close: async () => {
      await client.close();
      await daemon.close();
      if (options.providerHistory) {
        await rm(path.dirname(daemon.paseoHome), { recursive: true, force: true });
        await rm(daemon.staticDir, { recursive: true, force: true });
      }
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test.each([undefined, "ordinary-profile", "paseo-workflow-planner"])(
  "workspace intention reaches every new agent once (profile: %s)",
  async (launchProfileId) => {
    const intent = "  Preserve the exact user purpose.  ";
    const f = await lifecycleFixture({ intent });
    try {
      const agent = await f.client.createAgent({
        provider: "codex",
        cwd: f.directory,
        workspaceId: f.workspace.id,
        launchProfileId,
        systemPrompt: "Existing instruction",
      });
      const prompt = f.daemon.daemon.agentManager.getAgent(agent.id)!.config.systemPrompt!;
      expect(prompt).toContain("Existing instruction");
      expect(prompt.split(`Workspace intention:\n${intent}`)).toHaveLength(2);
    } finally {
      await f.close();
    }
  },
  60_000,
);

test("ordinary workspace create captures the selected profile approval mode before later profile edits", async () => {
  const f = await lifecycleFixture();
  try {
    await f.client.patchDaemonConfig({
      agentProfiles: [
        ...profiles,
        {
          id: "ordinary-profile",
          name: "Ordinary",
          provider: "codex",
          postApprovalModeId: "auto",
        },
      ],
    });
    const agent = await f.client.createAgent({
      provider: "codex",
      cwd: f.directory,
      workspaceId: f.workspace.id,
      launchProfileId: "ordinary-profile",
      systemPrompt: "No workspace intention",
    });
    expect(agent.launchPostApprovalModeId).toBe("auto");
    await f.client.patchDaemonConfig({ agentProfiles: profiles });
    await f.client.reloadPlugin("paseo-workflow");
    const stored = f.daemon.daemon.agentManager.getAgent(agent.id)!;
    expect(stored.launchProfileId).toBe("ordinary-profile");
    expect(stored.launchPostApprovalModeId).toBe("auto");
    expect(stored.config.systemPrompt).toBe("No workspace intention");
  } finally {
    await f.close();
  }
}, 60_000);

async function pendingPlan(
  f: Awaited<ReturnType<typeof lifecycleFixture>>,
  plannerId?: string,
  callId = "plan-1",
) {
  const manager = f.daemon.daemon.agentManager;
  const planner = plannerId
    ? manager.getAgent(plannerId)!
    : await f.client.createAgent({
        provider: "codex",
        cwd: f.directory,
        workspaceId: f.workspace.id,
        launchProfileId: "paseo-workflow-planner",
        modeId: "full-access",
      });
  if (!plannerId) {
    await f.client.sendMessage(planner.id, "Build the requested feature");
    await expect.poll(() => manager.getAgent(planner.id)?.lifecycle).toBe("idle");
  }
  const context = {
    workspaceId: f.workspace.id,
    agentId: planner.id,
    permissionRequestId: `permission-${callId}`,
    callId,
    text: `Exact ${callId}`,
  };
  await manager.appendTimelineItem(planner.id, {
    type: "tool_call",
    callId,
    name: "plan_approval",
    status: "running",
    error: null,
    detail: { type: "plan", text: context.text },
  });
  manager.getAgent(planner.id)!.pendingPermissions.set(context.permissionRequestId, {
    id: context.permissionRequestId,
    provider: "codex",
    name: "Plan",
    kind: "plan",
    sourcePlanCallId: callId,
    input: { plan: context.text },
  });
  return context;
}

function approvedPlanEntry(plan: { callId: string; text: string }): AgentStreamEvent {
  return {
    type: "timeline",
    provider: "codex",
    item: {
      type: "tool_call",
      callId: plan.callId,
      name: "plan_approval",
      status: "completed",
      error: null,
      detail: { type: "plan", text: plan.text },
      metadata: { approved: true, actionId: "implement", resolution: { behavior: "allow" } },
    },
  };
}

async function publishPlanApproval(
  f: Awaited<ReturnType<typeof lifecycleFixture>>,
  plan: Awaited<ReturnType<typeof pendingPlan>>,
) {
  const manager = f.daemon.daemon.agentManager;
  const session = manager.getAgent(plan.agentId)!.session!;
  const emit = (
    session as unknown as { notifySubscribers(event: AgentStreamEvent): void }
  ).notifySubscribers.bind(session);
  emit(approvedPlanEntry(plan));
  emit({
    type: "permission_resolved",
    provider: "codex",
    requestId: plan.permissionRequestId,
    resolution: { behavior: "allow" },
  });
  await manager.flush();
  await expect
    .poll(async () => (await f.read()).values.workflows[plan.agentId]?.plans[plan.callId]?.approved)
    .toBe(true);
}

test("an ordinary conversation classifies its pending plan and hands it to one direct-config executor", async () => {
  const f = await lifecycleFixture();
  try {
    await f.client.patchDaemonConfig({
      agentProfiles: [
        ...profiles,
        { id: "ordinary-profile", name: "Ordinary", provider: "codex", modeId: "full-access" },
      ],
    });
    const ordinary = await f.client.createAgent({
      provider: "codex",
      cwd: f.directory,
      workspaceId: f.workspace.id,
      launchProfileId: "ordinary-profile",
      modeId: "full-access",
    });
    await f.client.sendMessage(ordinary.id, "Plan this existing conversation");
    await expect
      .poll(() => f.daemon.daemon.agentManager.getAgent(ordinary.id)?.lifecycle)
      .toBe("idle");
    f.replies.set("router", [
      '{"category":"bounded","provider":"codex","model":"gpt-5.6-sol","effort":"medium","reason":"Scoped fix"}',
    ]);
    const plan = await pendingPlan(f, ordinary.id, "ordinary-plan");
    await expect(
      f.client.invokePluginRpc("paseo-workflow", "workflow.plan.handoff.request", plan),
    ).resolves.toMatchObject({ agentId: expect.any(String) });
    expect(f.agents("executor-standard")).toHaveLength(0);
    let classifier!: StoredAgentRecord;
    await expect
      .poll(async () => {
        classifier = (await f.daemon.daemon.agentStorage.list()).find(
          (record) => record.labels["paseo.workflow.role"] === "execution-router",
        )!;
        return classifier?.archivedAt ?? null;
      })
      .toBeTruthy();
    expect(classifier.launchProfileId).toBeUndefined();
    expect(classifier.config.model).toBe("gpt-5.6-sol");
    expect(classifier.config.thinkingOptionId).toBe("medium");
    expect(
      f.prompts.filter((prompt) => prompt.text.startsWith("Classify the workflow plan")),
    ).toHaveLength(1);
    expect(f.labelled("executor-bounded")).toHaveLength(1);
    const executor = f.labelled("executor-bounded")[0]!;
    expect(executor.launchProfileId).toBeUndefined();
    expect(executor.config.model).toBe("gpt-5.6-sol");
    expect(executor.config.thinkingOptionId).toBe("medium");
    expect(executor.config.writePolicy).toBe("read_write");
    expect(f.prompts.filter((prompt) => prompt.text.startsWith("/paseo-handoff"))).toHaveLength(1);
    await f.client.reloadPlugin("paseo-workflow");
    await f.client.invokePluginRpc("paseo-workflow", "workflow.status.get.request", {
      agentId: ordinary.id,
      workspaceId: f.workspace.id,
    });
    expect(f.labelled("executor-bounded")).toHaveLength(1);
    expect(f.prompts.filter((prompt) => prompt.text.startsWith("/paseo-handoff"))).toHaveLength(1);
    await expect
      .poll(
        async () =>
          (await f.read()).values.workflows[plan.agentId!]?.plans[plan.callId]?.verification,
      )
      .toBeTruthy();
  } finally {
    await f.close();
  }
}, 60_000);

test.each(["no-commit", "no-target"] as const)(
  "implementation completion exposes verification required (%s)",
  async (reason) => {
    const f = await lifecycleFixture({ target: reason !== "no-target" });
    try {
      const plan = await pendingPlan(f);
      const instruction = f.daemon.daemon.agentManager.getAgent(plan.agentId)!.config.systemPrompt!;
      expect(instruction).toContain("After approval");
      expect(instruction).toContain("functional commit");
      await f.client.invokePluginRpc("paseo-workflow", "workflow.handoff.prepare.request", plan);
      await publishPlanApproval(f, plan);
      await writeFile(path.join(f.directory, "feature.txt"), "implemented\n");
      if (reason !== "no-commit") f.git("commit", "--quiet", "-am", "functional");
      await f.client.sendMessage(plan.agentId, "Implementation finished");
      await expect
        .poll(async () =>
          f.client.invokePluginRpc("paseo-workflow", "workflow.status.get.request", {
            agentId: plan.agentId,
            workspaceId: plan.workspaceId,
          }),
        )
        .toMatchObject({ verification: [{ planId: plan.callId, phase: "verification_required" }] });
      expect(f.agents("final-review")).toHaveLength(0);
      await f.client.reloadPlugin("paseo-workflow");
      expect((await f.read()).values.workflows[plan.agentId]!.plans[plan.callId]).toHaveProperty(
        "verification",
      );
    } finally {
      await f.close();
    }
  },
  60_000,
);

test("final diff uses the remote target merge base while commit progression uses workflow start HEAD", async () => {
  const f = await lifecycleFixture();
  f.canceled.add("final-review");
  try {
    const targetBase = f.git("rev-parse", "HEAD");
    await writeFile(path.join(f.directory, "existing.txt"), "pre-existing branch commit\n");
    f.git("add", "existing.txt");
    f.git("commit", "--quiet", "-m", "pre-existing feature");
    const startHead = f.git("rev-parse", "HEAD");
    const plan = await pendingPlan(f);
    await f.client.invokePluginRpc("paseo-workflow", "workflow.handoff.prepare.request", plan);
    expect((await f.read()).values.workflows[plan.agentId]!.git).toMatchObject({
      startHead,
      targetBase,
    });
    await publishPlanApproval(f, plan);
    await writeFile(path.join(f.directory, "feature.txt"), "functional\n");
    f.git("commit", "--quiet", "-am", "functional");
    await f.client.sendMessage(plan.agentId, "Implementation committed");
    await expect
      .poll(() => f.prompts.find((prompt) => prompt.role === "final-review")?.text)
      .toContain("pre-existing branch commit");
    expect(f.prompts.find((prompt) => prompt.role === "final-review")!.text).toContain(startHead);
  } finally {
    await f.close();
  }
}, 60_000);

test.each(["router", "executor-standard"] as const)(
  "status reconciles a completed %s during plugin downtime exactly once",
  async (role) => {
    const f = await lifecycleFixture();
    let release!: () => void;
    f.holds.set(
      role,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    f.canceled.add("final-review");
    f.replies.set("router", [
      '{"ready":true,"recommendation":"standard","constraints":[],"assumptions":[]}',
    ]);
    try {
      let ownerId: string;
      if (role === "router") {
        const router = await f.client.createAgent({
          provider: "codex",
          cwd: f.directory,
          workspaceId: f.workspace.id,
          launchProfileId: "paseo-workflow-router",
          modeId: "full-access",
        });
        ownerId = router.id;
        await f.client.sendMessage(router.id, "Build the feature");
      } else {
        const plan = await pendingPlan(f);
        ownerId = plan.agentId;
        f.replies.set("router", [
          '{"category":"complex","provider":"codex","model":"gpt-6-astra","effort":"high","reason":"Coordinated changes"}',
        ]);
        f.effects.set("router", async (text) => {
          if (text.startsWith("/paseo-handoff")) {
            await writeFile(path.join(f.directory, "feature.txt"), "functional\n");
            f.git("commit", "--quiet", "-am", "functional");
          }
        });
        await f.client.invokePluginRpc("paseo-workflow", "workflow.plan.handoff.request", {
          ...plan,
          selection: "standard",
        });
      }
      await f.client.disablePlugin("paseo-workflow");
      release();
      await expect
        .poll(() =>
          role === "router"
            ? f.agents("router")[0]?.lifecycle
            : f.labelled("executor-complex")[0]?.lifecycle,
        )
        .toBe("idle");
      await f.client.enablePlugin("paseo-workflow");
      const status = () =>
        f.client.invokePluginRpc("paseo-workflow", "workflow.status.get.request", {
          agentId: ownerId,
          workspaceId: f.workspace.id,
        });
      await status();
      const nextRole = nextRoleFor(role);
      expect(f.agents(nextRole)).toHaveLength(1);
      await f.client.reloadPlugin("paseo-workflow");
      await status();
      await status();
      expect(f.agents(nextRole)).toHaveLength(1);
      expect(f.prompts.filter((prompt) => prompt.role === nextRole)).toHaveLength(1);
    } finally {
      release();
      await f.close();
    }
  },
  60_000,
);

test.each([false, true])(
  "real manager lifecycle separates classification, correction decision and validation evidence turns (reused turnId: %s)",
  async (reuse) => {
    const f = await lifecycleFixture();
    try {
      if (reuse) f.reusedTurnIds.add("final-review");
      f.effects.set("audit-economic", async () => {
        if (reuse) await f.daemon.daemon.agentManager.closeAgent(f.agents("final-review")[0]!.id);
      });
      f.replies.set("final-review", [
        '{"classification":"SIMPLE"}',
        '{"correct":true,"validationCommands":["npm run targeted"]}',
        "Correction done without observable checks",
      ]);
      f.toolEvidence.set("final-review", "npm run targeted");
      f.effects.set("final-review", async (text) => {
        if (text.startsWith("Correct only"))
          await writeFile(path.join(f.directory, "feature.txt"), "corrected\n");
      });
      f.replies.set("audit-economic", [
        JSON.stringify({
          findings: [
            {
              summary: "Local defect",
              files: ["feature.txt"],
              certain: true,
              local: true,
              verifiable: true,
              externalEffects: false,
            },
          ],
        }),
      ]);
      const plan = await pendingPlan(f);
      await f.client.invokePluginRpc("paseo-workflow", "workflow.handoff.prepare.request", plan);
      await publishPlanApproval(f, plan);
      await writeFile(path.join(f.directory, "feature.txt"), "functional\n");
      f.git("add", "feature.txt");
      f.git("commit", "--quiet", "-m", "functional");
      await f.client.sendMessage(plan.agentId, "Implementation committed");
      await expect
        .poll(
          async () =>
            (await f.read()).values.workflows[plan.agentId]?.plans[plan.callId]?.final?.phase,
          { timeout: 10_000 },
        )
        .toBe("verification_required");
      expect(f.prompts.filter((prompt) => prompt.role === "final-review")).toHaveLength(3);
      expect(f.agents("audit-economic")).toHaveLength(1);
      const history = await f.daemon.daemon.agentManager.getTimelineRows(
        f.agents("final-review")[0]!.id,
      );
      const evidence = history.find((row) => row.item.type === "tool_call")!;
      const lastPrompt = history.findLast((row) => row.item.type === "user_message")!;
      expect(history.indexOf(evidence)).toBeLessThan(history.indexOf(lastPrompt));
      expect(evidence.turnId === history.at(-1)?.turnId).toBe(reuse);
    } finally {
      await f.close();
    }
  },
  60_000,
);

test.each(["same-file", "head", "untracked", "staged"] as const)(
  "concurrent %s changes after audit prevent the correction prompt",
  async (change) => {
    const f = await lifecycleFixture();
    try {
      f.replies.set("final-review", [
        '{"classification":"SIMPLE"}',
        '{"correct":true,"validationCommands":["npm run test:target"]}',
      ]);
      f.replies.set("audit-economic", [
        '{"findings":[{"summary":"Certain local bug","files":["feature.txt"],"certain":true,"local":true,"verifiable":true,"externalEffects":false}]}',
      ]);
      f.effects.set("final-review", async (text) => {
        if (!text.startsWith("Evaluate these findings")) return;
        await writeFile(
          path.join(f.directory, change === "untracked" ? "concurrent.txt" : "feature.txt"),
          "concurrent owner edit\n",
        );
        if (change === "staged") f.git("add", "feature.txt");
        if (change === "head") f.git("commit", "--quiet", "-am", "concurrent commit");
      });
      const plan = await pendingPlan(f);
      await f.client.invokePluginRpc("paseo-workflow", "workflow.handoff.prepare.request", plan);
      await publishPlanApproval(f, plan);
      await writeFile(path.join(f.directory, "feature.txt"), "functional\n");
      f.git("commit", "--quiet", "-am", "functional");
      await f.client.sendMessage(plan.agentId, "Implementation committed");
      await expect
        .poll(
          async () =>
            (await f.read()).values.workflows[plan.agentId]?.plans[plan.callId]?.final?.phase,
          { timeout: 10_000 },
        )
        .toBe("verification_required");
      expect(f.prompts.filter((prompt) => prompt.role === "final-review")).toHaveLength(2);
      expect(f.prompts.some((prompt) => prompt.text.startsWith("Correct only"))).toBe(false);
    } finally {
      await f.close();
    }
  },
  60_000,
);

test("approval preserves the hook without reviewing an old planning turn when HEAD advanced before followup", async () => {
  const f = await lifecycleFixture();
  let release!: () => void;
  f.holds.set(
    "final-review",
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  f.canceled.add("final-review");
  try {
    const plan = await pendingPlan(f);
    await f.client.invokePluginRpc("paseo-workflow", "workflow.handoff.prepare.request", plan);
    const manager = f.daemon.daemon.agentManager;
    await manager.setAgentMode(plan.agentId, "plan");
    const session = manager.getAgent(plan.agentId)!.session!;
    const respond = session.respondToPermission.bind(session);
    // The deterministic provider exposes its notifier privately; keep the real manager queue/hooks.
    const emit = (
      session as unknown as { notifySubscribers(event: AgentStreamEvent): void }
    ).notifySubscribers.bind(session);
    const planningTurn = manager.getAgent(plan.agentId)!.lastCompletedTurnId;
    await writeFile(path.join(f.directory, "feature.txt"), "concurrent change\n");
    f.git("add", "feature.txt");
    f.git("commit", "--quiet", "-m", "concurrent change before implementation");
    session.respondToPermission = async (...args) => {
      await respond(...args);
      emit({ ...approvedPlanEntry(plan), turnId: planningTurn });
      emit({
        type: "permission_resolved",
        provider: "codex",
        requestId: plan.permissionRequestId,
        resolution: { behavior: "allow" },
      });
      throw new Error("Provider approval ACK lost after consumption");
    };
    const resolutions: string[] = [];
    manager.subscribe(
      (event) => {
        if (event.type === "agent_stream" && event.event.type === "permission_resolved")
          resolutions.push(event.event.requestId);
      },
      { agentId: plan.agentId, replayState: false },
    );
    await expect(
      manager.respondToPermission(plan.agentId, plan.permissionRequestId, { behavior: "allow" }),
    ).rejects.toThrow("ACK lost");
    await expect
      .poll(
        async () => (await f.read()).values.workflows[plan.agentId]?.plans[plan.callId]?.approved,
      )
      .toBe(true);
    await f.client.reloadPlugin("paseo-workflow");
    const state = (await f.read()).values.workflows[plan.agentId]!;
    expect(state.plans[plan.callId]?.approved).toBe(true);
    expect(state.activePlanId).toBe(plan.callId);
    await f.client.invokePluginRpc("paseo-workflow", "workflow.status.get.request", {
      agentId: plan.agentId,
      workspaceId: plan.workspaceId,
    });
    expect(f.agents("final-review")).toHaveLength(0);
    expect(
      (await f.read()).values.workflows[plan.agentId]!.plans[plan.callId]!.final,
    ).toBeUndefined();
    expect(manager.getAgent(plan.agentId)!.lastCompletedTurnId).toBe(planningTurn);
    expect(resolutions).toEqual([plan.permissionRequestId]);
    expect(await session.getCurrentMode()).toBe("auto");
    expect(manager.getAgent(plan.agentId)!.pendingPermissions.has(plan.permissionRequestId)).toBe(
      false,
    );
  } finally {
    release();
    await f.close();
  }
}, 60_000);

test.each(["reversed", "normal", "reload", "same-turn-assistant", "same-turn-tool"] as const)(
  "approved planner completion starts one final review (%s order)",
  async (order) => {
    const f = await lifecycleFixture();
    let release!: () => void;
    f.holds.set(
      "final-review",
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    f.canceled.add("final-review");
    try {
      const plan = await pendingPlan(f);
      await f.client.invokePluginRpc("paseo-workflow", "workflow.handoff.prepare.request", plan);
      const manager = f.daemon.daemon.agentManager;
      const session = manager.getAgent(plan.agentId)!.session!;
      const respond = session.respondToPermission.bind(session);
      const emit = (
        session as unknown as { notifySubscribers(event: AgentStreamEvent): void }
      ).notifySubscribers.bind(session);
      const sameTurn = order.startsWith("same-turn-");
      const turnId = "approved-implementation";
      const resolution: AgentStreamEvent = {
        type: "permission_resolved",
        provider: "codex",
        requestId: plan.permissionRequestId,
        resolution: { behavior: "allow" },
        turnId,
      };
      const completed: AgentStreamEvent = { type: "turn_completed", provider: "codex", turnId };
      const begin = () => {
        emit({ type: "turn_started", provider: "codex", turnId });
        emit({
          type: "timeline",
          provider: "codex",
          turnId,
          item: {
            type: "user_message",
            text: sameTurn
              ? "Plan the feature, then wait for approval"
              : "Implement the approved plan",
            clientMessageId: "approved-prompt",
          },
        });
      };
      const finish = async () => {
        await writeFile(path.join(f.directory, "feature.txt"), "functional\n");
        f.git("add", "feature.txt");
        f.git("commit", "--quiet", "-m", "functional");
        emit({
          type: "timeline",
          provider: "codex",
          turnId,
          item:
            order === "same-turn-tool"
              ? {
                  type: "tool_call",
                  callId: "implementation-commit",
                  name: "shell",
                  status: "completed",
                  error: null,
                  detail: { type: "shell", command: "git commit -m functional", exitCode: 0 },
                }
              : { type: "assistant_message", text: "Functional change committed" },
        });
        emit(completed);
      };
      session.respondToPermission = async (...args) => {
        await respond(...args);
        emit({ ...approvedPlanEntry(plan), turnId });
        emit(resolution);
        if (order === "reversed") {
          begin();
          await finish();
          throw new Error("Approval ACK rejected after completion");
        }
        return sameTurn ? undefined : { followUpPrompt: "Implement the approved plan" };
      };
      const delivered: string[] = [];
      manager.subscribe(
        (event) => {
          if (
            event.type === "agent_stream" &&
            ["permission_resolved", "turn_completed"].includes(event.event.type)
          )
            delivered.push(event.event.type);
        },
        { agentId: plan.agentId, replayState: false },
      );
      if (sameTurn) begin();
      const approval = manager.respondToPermission(plan.agentId, plan.permissionRequestId, {
        behavior: "allow",
      });
      if (order === "reversed") await expect(approval).rejects.toThrow("ACK rejected");
      else await approval;
      await expect
        .poll(
          async () => (await f.read()).values.workflows[plan.agentId]?.plans[plan.callId]?.approved,
        )
        .toBe(true);
      if (order === "reload") await f.client.disablePlugin("paseo-workflow");
      if (order !== "reversed") {
        if (!sameTurn) begin();
        await finish();
      }
      await manager.flush();
      expect(delivered).toEqual(
        order === "reversed"
          ? ["turn_completed", "permission_resolved"]
          : ["permission_resolved", "turn_completed"],
      );
      const status = () =>
        f.client.invokePluginRpc("paseo-workflow", "workflow.status.get.request", {
          agentId: plan.agentId,
          workspaceId: plan.workspaceId,
        });
      if (order === "reload") {
        await f.client.enablePlugin("paseo-workflow");
        await f.client.reloadPlugin("paseo-workflow");
        await status();
      }
      await expect
        .poll(
          async () =>
            (await f.read()).values.workflows[plan.agentId]?.plans[plan.callId]?.final?.phase,
        )
        .toBe("classifying");
      const finalId = f.agents("final-review")[0]!.id;
      emit(resolution);
      emit(completed);
      await manager.flush();
      await f.client.reloadPlugin("paseo-workflow");
      await status();
      await status();
      expect(f.agents("final-review").map((agent) => agent.id)).toEqual([finalId]);
      expect(f.prompts.filter((prompt) => prompt.role === "final-review")).toHaveLength(1);
      expect(
        (await f.read()).values.workflows[plan.agentId]?.plans[plan.callId]?.final?.phase,
      ).toBe("classifying");
    } finally {
      release();
      await f.close();
    }
  },
  60_000,
);

test("review finishing during failed permission close is consumed once after retry and reload", async () => {
  const f = await lifecycleFixture();
  let release!: () => void;
  f.holds.set(
    "plan-reviewer",
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  try {
    const plan = await pendingPlan(f);
    f.replies.set("plan-reviewer", ["Preserve the existing CSV export"]);
    f.permissionFailures.set("planner", 1);
    await expect(
      f.client.invokePluginRpc("paseo-workflow", "workflow.plan.review.request", plan),
    ).rejects.toThrow("deny failure");
    expect(
      f.daemon.daemon.agentManager
        .getAgent(plan.agentId)!
        .pendingPermissions.has(plan.permissionRequestId),
    ).toBe(true);
    expect(f.agents("plan-reviewer")).toHaveLength(1);
    const childId = f.agents("plan-reviewer")[0]!.id;
    expect(f.prompts.filter((prompt) => prompt.role === "plan-reviewer")).toHaveLength(1);
    release();
    await expect.poll(() => f.agents("plan-reviewer")[0]?.lifecycle).toBe("idle");
    await f.daemon.daemon.agentManager.flush();
    const status = () =>
      f.client.invokePluginRpc("paseo-workflow", "workflow.status.get.request", {
        agentId: plan.agentId,
        workspaceId: plan.workspaceId,
      });
    await status();
    expect((await f.read()).values.workflows[plan.agentId]?.plans[plan.callId]?.review?.phase).toBe(
      "closing",
    );
    expect(f.prompts.filter((prompt) => prompt.text.startsWith("Revise the plan"))).toHaveLength(0);
    await f.client.reloadPlugin("paseo-workflow");
    await f.client.invokePluginRpc("paseo-workflow", "workflow.plan.review.request", plan);
    await status();
    expect((await f.read()).values.workflows[plan.agentId]?.plans[plan.callId]?.review?.phase).toBe(
      "complete",
    );
    await f.client.reloadPlugin("paseo-workflow");
    await status();
    expect(f.agents("plan-reviewer").map((agent) => agent.id)).toEqual([childId]);
    expect(f.prompts.filter((prompt) => prompt.role === "plan-reviewer")).toHaveLength(1);
    const revisions = f.prompts.filter((prompt) => prompt.text.startsWith("Revise the plan"));
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.text).toContain("Preserve the existing CSV export");
  } finally {
    release();
    await f.close();
  }
}, 60_000);

test("review send rejection keeps the live plan retryable and delivers once to the same child", async () => {
  const f = await lifecycleFixture();
  try {
    const plan = await pendingPlan(f);
    f.sendFailures.set("plan-reviewer", "not-accepted");
    await expect(
      f.client.invokePluginRpc("paseo-workflow", "workflow.plan.review.request", plan),
    ).rejects.toThrow("prompt rejection");
    expect(
      f.daemon.daemon.agentManager
        .getAgent(plan.agentId)!
        .pendingPermissions.has(plan.permissionRequestId),
    ).toBe(true);
    const childId = f.agents("plan-reviewer")[0]!.id;
    expect(f.prompts.filter((prompt) => prompt.role === "plan-reviewer")).toHaveLength(0);
    await f.client.reloadPlugin("paseo-workflow");
    await f.client.invokePluginRpc("paseo-workflow", "workflow.plan.review.request", plan);
    expect(f.agents("plan-reviewer").map((agent) => agent.id)).toEqual([childId]);
    expect(f.prompts.filter((prompt) => prompt.role === "plan-reviewer")).toHaveLength(1);
    expect(
      f.daemon.daemon.agentManager
        .getAgent(plan.agentId)!
        .pendingPermissions.has(plan.permissionRequestId),
    ).toBe(false);
  } finally {
    await f.close();
  }
}, 60_000);

test("unknown reviewer delivery leaves the plan pending without replay after plugin reload", async () => {
  const f = await lifecycleFixture();
  try {
    const plan = await pendingPlan(f);
    f.sendFailures.set("plan-reviewer", "unknown");
    await expect(
      f.client.invokePluginRpc("paseo-workflow", "workflow.plan.review.request", plan),
    ).rejects.toThrow("outcome_unknown");
    expect(
      f.daemon.daemon.agentManager
        .getAgent(plan.agentId)!
        .pendingPermissions.has(plan.permissionRequestId),
    ).toBe(true);
    expect((await f.read()).values.workflows[plan.agentId]?.plans[plan.callId]?.review?.phase).toBe(
      "outcome_unknown",
    );
    await f.client.reloadPlugin("paseo-workflow");
    await expect(
      f.client.invokePluginRpc("paseo-workflow", "workflow.plan.review.request", plan),
    ).rejects.toThrow("outcome_unknown");
    expect(f.prompts.filter((prompt) => prompt.role === "plan-reviewer")).toHaveLength(1);
    expect(f.prompts.filter((prompt) => prompt.text.startsWith("Revise the plan"))).toHaveLength(0);
    expect(f.agents("plan-reviewer")).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 60_000);

test("Planner clarification after routing is transported in review, handoff and final manager prompts", async () => {
  const f = await lifecycleFixture();
  try {
    f.replies.set("router", [
      '{"ready":true,"recommendation":"advanced","constraints":[],"assumptions":[]}',
      '{"category":"diagnostic","provider":"codex","model":"gpt-5.6-sol","effort":"high","reason":"Several modules"}',
    ]);
    f.replies.set("final-review", ['{"classification":"SIMPLE"}']);
    f.replies.set("audit-economic", ['{"findings":[]}']);
    const router = await f.client.createAgent({
      provider: "codex",
      cwd: f.directory,
      workspaceId: f.workspace.id,
      launchProfileId: "paseo-workflow-router",
      modeId: "full-access",
    });
    await f.client.sendMessage(router.id, "Build a compatible feature");
    await expect.poll(() => f.agents("planner").length).toBe(1);
    const planner = f.agents("planner")[0]!;
    await expect.poll(() => f.agents("planner")[0]?.lifecycle).toBe("idle");
    const clarification = (
      "Clarification: retain the CSV export without adding dependencies. " +
      "Detailed requirement. ".repeat(500)
    ).trim();
    await f.client.sendMessage(planner.id, clarification);
    await expect.poll(() => f.agents("planner")[0]?.lifecycle).toBe("idle");
    for (let index = 0; index < 11; index++) {
      await f.client.sendMessage(planner.id, `Additional clarification ${index}`);
      await expect.poll(() => f.agents("planner")[0]?.lifecycle).toBe("idle");
    }
    const reviewPlan = await pendingPlan(f, planner.id);
    expect(
      f.daemon.daemon.agentManager
        .getTimeline(planner.id)
        .find((item) => item.type === "user_message" && item.text.startsWith("Clarification:")),
    ).toMatchObject({ text: clarification });
    await f.client.invokePluginRpc("paseo-workflow", "workflow.plan.review.request", reviewPlan);
    await expect
      .poll(
        async () =>
          (await f.read()).values.workflows[router.id]?.plans[reviewPlan.callId]?.review?.phase,
      )
      .toBe("complete");
    await expect.poll(() => f.agents("planner")[0]?.lifecycle).toBe("idle");
    const plan = await pendingPlan(f, planner.id, "plan-2");
    await f.client.invokePluginRpc("paseo-workflow", "workflow.handoff.prepare.request", plan);
    await f.client.invokePluginRpc("paseo-workflow", "workflow.plan.handoff.request", plan);
    const executor = f.labelled("executor-diagnostic")[0]!;
    await expect.poll(() => f.labelled("executor-diagnostic")[0]?.lifecycle).toBe("idle");
    await writeFile(path.join(f.directory, "feature.txt"), "functional\n");
    f.git("add", "feature.txt");
    f.git("commit", "--quiet", "-m", "functional");
    await f.client.sendMessage(executor.id, "Implemented and committed");
    await expect
      .poll(() => f.prompts.filter((prompt) => prompt.role === "final-review").length)
      .toBeGreaterThan(0);
    for (const role of ["plan-reviewer", "final-review"])
      expect(
        f.prompts.find((prompt) => prompt.role === role)?.text.includes(clarification),
        role,
      ).toBe(true);
    expect(
      f.prompts
        .find((prompt) => prompt.text.startsWith("/paseo-handoff"))
        ?.text.includes(clarification),
    ).toBe(true);
    await f.client.reloadPlugin("paseo-workflow");
    expect(
      await f.client.invokePluginRpc("paseo-workflow", "workflow.status.get.request", {
        agentId: planner.id,
        workspaceId: plan.workspaceId,
      }),
    ).toMatchObject({ handoff: { phase: "running", agentId: executor.id } });
  } finally {
    await f.close();
  }
}, 60_000);

test.each(["initial", "final"])(
  "untracked files at %s snapshot prevent completion even with empty audits",
  async (when) => {
    const f = await lifecycleFixture();
    try {
      f.replies.set("final-review", ['{"classification":"SIMPLE"}']);
      f.replies.set("audit-economic", ['{"findings":[]}']);
      const plan = await pendingPlan(f);
      if (when === "initial")
        await writeFile(path.join(f.directory, "untracked.txt"), "not in git diff\n");
      await f.client.invokePluginRpc("paseo-workflow", "workflow.handoff.prepare.request", plan);
      await publishPlanApproval(f, plan);
      const state = (await f.read()).values;
      await writeFile(path.join(f.directory, "feature.txt"), "functional\n");
      f.git("add", "feature.txt");
      f.git("commit", "--quiet", "-m", "functional");
      if (when === "final")
        await writeFile(path.join(f.directory, "untracked.txt"), "not in git diff\n");
      await f.client.sendMessage(plan.agentId, "Implemented and committed");
      await expect
        .poll(
          async () =>
            (await f.read()).values.workflows[plan.agentId]?.plans[plan.callId]?.final?.phase,
          { timeout: 10_000 },
        )
        .toBe("verification_required");
      expect(f.git("diff", state.workflows[plan.agentId]!.git.targetBase!)).not.toContain(
        "untracked.txt",
      );
    } finally {
      await f.close();
    }
  },
  60_000,
);

test("a completed structured proposal without native permission is ensured and approved once in the same conversation", async () => {
  const f = await lifecycleFixture();
  try {
    const plan = await pendingPlan(f);
    const manager = f.daemon.daemon.agentManager;
    manager.getAgent(plan.agentId)!.pendingPermissions.clear();
    await manager.appendTimelineItem(plan.agentId, {
      type: "tool_call",
      callId: plan.callId,
      name: "propose_plan",
      status: "completed",
      error: null,
      detail: { type: "plan", text: plan.text },
    });
    const ensure = () =>
      f.client.ensurePlanPermission({
        agentId: plan.agentId,
        workspaceId: plan.workspaceId,
        callId: plan.callId,
      });
    const permission = await ensure();
    expect(await ensure()).toEqual(permission);
    expect(permission).toMatchObject({
      kind: "plan",
      sourcePlanCallId: plan.callId,
      input: { plan: plan.text },
    });
    const session = manager.getAgent(plan.agentId)!.session!;
    session.respondToPermission = async () => {
      throw new Error("Native permission API must not be used");
    };
    const before = f.prompts.length;
    await f.client.respondToPermissionAndWait(plan.agentId, permission.id, { behavior: "allow" });
    await expect.poll(() => f.prompts.length).toBe(before + 1);
    expect(f.prompts.at(-1)!.text).toContain(plan.text);
    expect(f.agents("planner")).toHaveLength(1);
    const rows = manager.getTimeline(plan.agentId);
    expect(
      rows.find(
        (item) =>
          item.type === "tool_call" &&
          item.callId === plan.callId &&
          item.metadata?.approved === true,
      ),
    ).toBeDefined();
    await expect.poll(() => manager.getAgent(plan.agentId)?.lifecycle).toBe("idle");
    await expect(ensure()).rejects.toThrow("resolved");
    await expect(
      f.client.respondToPermissionAndWait(plan.agentId, permission.id, { behavior: "allow" }),
    ).rejects.toThrow("resolved");
    expect(f.prompts).toHaveLength(before + 1);
    await f.client.invokePluginRpc("paseo-workflow", "workflow.status.get.request", {
      workspaceId: plan.workspaceId,
      agentId: plan.agentId,
    });
    expect(
      (await f.read()).values.workflows[plan.agentId]!.plans[plan.callId]!.verification,
    ).toContain("functional commit");
  } finally {
    await f.close();
  }
}, 60_000);

test.each(["review", "handoff"] as const)(
  "structured fallback %s uses the verified server permission without native response",
  async (action) => {
    const f = await lifecycleFixture();
    try {
      const plan = await pendingPlan(f);
      const manager = f.daemon.daemon.agentManager;
      manager.getAgent(plan.agentId)!.pendingPermissions.clear();
      await manager.appendTimelineItem(plan.agentId, {
        type: "tool_call",
        callId: plan.callId,
        name: "proposal",
        status: "completed",
        error: null,
        detail: { type: "plan", text: plan.text },
      });
      const request = { agentId: plan.agentId, workspaceId: plan.workspaceId, callId: plan.callId };
      const permission = await f.client.ensurePlanPermission(request);
      manager.getAgent(plan.agentId)!.session!.respondToPermission = async () => {
        throw new Error("Native API forbidden");
      };
      f.replies.set("router", [
        '{"category":"diagnostic","provider":"codex","model":"gpt-5.6-sol","effort":"high","reason":"Several modules"}',
      ]);
      const context = { ...plan, permissionRequestId: permission.id };
      const method =
        action === "review" ? "workflow.plan.review.request" : "workflow.plan.handoff.request";
      const input = action === "review" ? context : { ...context, selection: "advanced" };
      const first = await f.client.invokePluginRpc("paseo-workflow", method, input);
      expect(await f.client.invokePluginRpc("paseo-workflow", method, input)).toEqual(first);
      expect(manager.getAgent(plan.agentId)!.pendingPermissions.size).toBe(0);
      expect(f.labelled("executor-diagnostic")).toHaveLength(action === "review" ? 0 : 1);
      await expect(f.client.ensurePlanPermission(request)).rejects.toThrow();
    } finally {
      await f.close();
    }
  },
  60_000,
);

test("structured ensure rejects forged/workspace/running/resolved plans and keeps its ID across reload", async () => {
  const f = await lifecycleFixture();
  try {
    const plan = await pendingPlan(f);
    const manager = f.daemon.daemon.agentManager;
    manager.getAgent(plan.agentId)!.pendingPermissions.clear();
    const input = { agentId: plan.agentId, workspaceId: plan.workspaceId, callId: plan.callId };
    await expect(
      f.client.ensurePlanPermission({ ...input, callId: "forged-plan" }),
    ).rejects.toThrow("canonical");
    await manager.appendTimelineItem(plan.agentId, {
      type: "tool_call",
      callId: plan.callId,
      name: "proposal",
      status: "completed",
      error: null,
      detail: { type: "plan", text: plan.text },
    });
    await expect(f.client.ensurePlanPermission({ ...input, workspaceId: "other" })).rejects.toThrow(
      "workspace",
    );
    let release!: () => void;
    f.holds.set(
      "planner",
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    await f.client.sendMessage(plan.agentId, "Clarify without executing");
    try {
      await expect(f.client.ensurePlanPermission(input)).rejects.toThrow("finish");
    } finally {
      release();
      f.holds.delete("planner");
    }
    await expect.poll(() => manager.getAgent(plan.agentId)?.lifecycle).toBe("idle");
    const permission = await f.client.ensurePlanPermission(input);
    await manager.reloadAgentSession(plan.agentId);
    expect((await f.client.ensurePlanPermission(input)).id).toBe(permission.id);
    await f.client.respondToPermissionAndWait(plan.agentId, permission.id, { behavior: "deny" });
    await expect(f.client.ensurePlanPermission(input)).rejects.toThrow("resolved");
  } finally {
    await f.close();
  }
}, 60_000);

test("synthetic followup ACK unknown persists a closed outcome and never retries after reload", async () => {
  const f = await lifecycleFixture();
  try {
    const plan = await pendingPlan(f);
    const manager = f.daemon.daemon.agentManager;
    manager.getAgent(plan.agentId)!.pendingPermissions.clear();
    await manager.appendTimelineItem(plan.agentId, {
      type: "tool_call",
      callId: plan.callId,
      name: "proposal",
      status: "completed",
      error: null,
      detail: { type: "plan", text: plan.text },
    });
    const permission = await f.client.ensurePlanPermission({
      agentId: plan.agentId,
      workspaceId: plan.workspaceId,
      callId: plan.callId,
    });
    f.sendFailures.set("planner", "unknown");
    const count = f.prompts.length;
    await expect(
      f.client.respondToPermissionAndWait(plan.agentId, permission.id, { behavior: "allow" }),
    ).rejects.toThrow("outcome_unknown");
    expect(f.prompts).toHaveLength(count + 1);
    await f.client.reloadPlugin("paseo-workflow");
    await expect(
      f.client.respondToPermissionAndWait(plan.agentId, permission.id, { behavior: "allow" }),
    ).rejects.toThrow("resolved");
    expect(f.prompts).toHaveLength(count + 1);
    expect(
      manager
        .getTimeline(plan.agentId)
        .some(
          (item) =>
            item.type === "tool_call" && item.metadata?.approvalOutcome === "outcome_unknown",
        ),
    ).toBe(true);
    expect(f.agents("final-review")).toHaveLength(0);
  } finally {
    await f.close();
  }
}, 60_000);

test("approval and implementation completed during plugin downtime reconcile once from canonical decisions", async () => {
  const f = await lifecycleFixture();
  f.canceled.add("final-review");
  try {
    const plan = await pendingPlan(f);
    await f.client.invokePluginRpc("paseo-workflow", "workflow.handoff.prepare.request", plan);
    await f.client.disablePlugin("paseo-workflow");
    const manager = f.daemon.daemon.agentManager;
    const session = manager.getAgent(plan.agentId)!.session!;
    const emit = (
      session as unknown as { notifySubscribers(event: AgentStreamEvent): void }
    ).notifySubscribers.bind(session);
    emit(approvedPlanEntry(plan));
    emit({
      type: "permission_resolved",
      provider: "codex",
      requestId: plan.permissionRequestId,
      resolution: { behavior: "allow" },
    });
    await manager.flush();
    await writeFile(path.join(f.directory, "feature.txt"), "functional\n");
    f.git("commit", "--quiet", "-am", "functional");
    await f.client.sendMessage(plan.agentId, "Implementation committed");
    await expect.poll(() => manager.getAgent(plan.agentId)?.lifecycle).toBe("idle");
    await f.client.enablePlugin("paseo-workflow");
    const status = () =>
      f.client.invokePluginRpc("paseo-workflow", "workflow.status.get.request", {
        agentId: plan.agentId,
        workspaceId: plan.workspaceId,
      });
    await status();
    expect(f.agents("final-review")).toHaveLength(1);
    await f.client.reloadPlugin("paseo-workflow");
    await status();
    expect(f.agents("final-review")).toHaveLength(1);
    expect((await f.read()).values.workflows[plan.agentId]?.plans[plan.callId]?.final?.phase).toBe(
      "classifying",
    );
  } finally {
    await f.close();
  }
}, 60_000);

test("review and approval racing on two clients cannot both acquire the plan", async () => {
  const f = await lifecycleFixture();
  const second = new DaemonClient({
    url: `ws://127.0.0.1:${f.daemon.port}/ws`,
    appVersion: "0.8.0",
  });
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.effects.set("plan-reviewer", () => barrier);
  try {
    await second.connect();
    const plan = await pendingPlan(f);
    const review = f.client.invokePluginRpc("paseo-workflow", "workflow.plan.review.request", plan);
    await expect.poll(() => f.prompts.some((prompt) => prompt.role === "plan-reviewer")).toBe(true);
    await expect(
      second.respondToPermissionAndWait(plan.agentId, plan.permissionRequestId, {
        behavior: "allow",
      }),
    ).rejects.toThrow("review");
    expect((await f.read()).values.workflows[plan.agentId]?.plans[plan.callId]).toMatchObject({
      review: { phase: "closing" },
    });
    expect(
      f.daemon.daemon.agentManager
        .getAgent(plan.agentId)!
        .pendingPermissions.has(plan.permissionRequestId),
    ).toBe(true);
    release();
    await review;
    await expect
      .poll(
        async () =>
          (await f.read()).values.workflows[plan.agentId]?.plans[plan.callId]?.review?.phase,
      )
      .toBe("complete");
    expect((await f.read()).values.workflows[plan.agentId]?.plans[plan.callId]?.approved).not.toBe(
      true,
    );
    expect(f.agents("plan-reviewer")).toHaveLength(1);
  } finally {
    release();
    await second.close();
    await f.close();
  }
}, 60_000);

test("a durable review claim blocks another client's approval even while the plugin is disabled", async () => {
  const f = await lifecycleFixture();
  const second = new DaemonClient({
    url: `ws://127.0.0.1:${f.daemon.port}/ws`,
    appVersion: "0.8.0",
  });
  try {
    await second.connect();
    const plan = await pendingPlan(f);
    f.failures.set("plan-reviewer", 1);
    await expect(
      f.client.invokePluginRpc("paseo-workflow", "workflow.plan.review.request", plan),
    ).rejects.toThrow("spawn failure");
    await f.client.disablePlugin("paseo-workflow");
    await expect(
      second.respondToPermissionAndWait(plan.agentId, plan.permissionRequestId, {
        behavior: "allow",
      }),
    ).rejects.toThrow("review");
    expect(
      f.daemon.daemon.agentManager
        .getAgent(plan.agentId)!
        .pendingPermissions.has(plan.permissionRequestId),
    ).toBe(true);
    await f.client.enablePlugin("paseo-workflow");
    await f.client.invokePluginRpc("paseo-workflow", "workflow.plan.review.request", plan);
    await expect
      .poll(
        async () =>
          (await f.read()).values.workflows[plan.agentId]?.plans[plan.callId]?.review?.phase,
      )
      .toBe("complete");
    expect((await f.read()).values.workflows[plan.agentId]?.plans[plan.callId]?.approved).not.toBe(
      true,
    );
  } finally {
    await second.close();
    await f.close();
  }
}, 60_000);

test("review RPC leaves the real permission retryable when reviewer creation fails", async () => {
  const f = await lifecycleFixture();
  try {
    const plan = await pendingPlan(f);
    f.failures.set("plan-reviewer", 1);
    await expect(
      f.client.invokePluginRpc("paseo-workflow", "workflow.plan.review.request", plan),
    ).rejects.toThrow("spawn failure");
    expect(
      f.daemon.daemon.agentManager
        .getAgent(plan.agentId)!
        .pendingPermissions.has(plan.permissionRequestId),
    ).toBe(true);
    const retry = await f.client.invokePluginRpc(
      "paseo-workflow",
      "workflow.plan.review.request",
      plan,
    );
    expect(retry).toMatchObject({ type: "workflow.plan.review.response" });
    expect(f.agents("plan-reviewer")).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 60_000);

test("review completed during plugin downtime reconciles from the real timeline exactly once", async () => {
  const f = await lifecycleFixture();
  let release!: () => void;
  f.holds.set(
    "plan-reviewer",
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  try {
    f.replies.set("plan-reviewer", ["Clarify the backward compatibility constraint"]);
    const plan = await pendingPlan(f);
    await f.client.invokePluginRpc("paseo-workflow", "workflow.plan.review.request", plan);
    await f.client.disablePlugin("paseo-workflow");
    release();
    await expect.poll(() => f.agents("plan-reviewer")[0]?.lifecycle).toBe("idle");
    await f.client.enablePlugin("paseo-workflow");
    await f.client.reloadPlugin("paseo-workflow");
    await f.client.invokePluginRpc("paseo-workflow", "workflow.status.get.request", {
      agentId: plan.agentId,
      workspaceId: plan.workspaceId,
    });
    await expect
      .poll(
        async () =>
          (await f.read()).values.workflows[plan.agentId]?.plans[plan.callId]?.review?.phase,
      )
      .toBe("complete");
    await f.client.reloadPlugin("paseo-workflow");
    await f.client.invokePluginRpc("paseo-workflow", "workflow.status.get.request", {
      agentId: plan.agentId,
      workspaceId: plan.workspaceId,
    });
    expect(
      f.prompts.filter(
        (prompt) => prompt.role === "planner" && prompt.text.startsWith("Revise the plan"),
      ),
    ).toHaveLength(1);
  } finally {
    release();
    await f.close();
  }
}, 60_000);

test.each([false, true])(
  "real Router lifecycle uses its ready JSON turn after an interactive question (reused turnId: %s)",
  async (reuse) => {
    const f = await lifecycleFixture();
    try {
      if (reuse) f.reusedTurnIds.add("router");
      f.replies.set("router", [
        "Which compatibility must remain?",
        JSON.stringify({
          ready: true,
          recommendation: "advanced",
          constraints: ["Keep old clients"],
          assumptions: [],
        }),
      ]);
      const router = await f.client.createAgent({
        provider: "codex",
        cwd: f.directory,
        workspaceId: f.workspace.id,
        launchProfileId: "paseo-workflow-router",
        modeId: "full-access",
      });
      await f.client.sendMessage(router.id, "Build the feature");
      await expect
        .poll(() =>
          f.daemon.daemon.agentManager
            .getTimeline(router.id)
            .some(
              (item) => item.type === "assistant_message" && item.text.includes("compatibility"),
            ),
        )
        .toBe(true);
      await expect.poll(() => f.agents("router")[0]?.lifecycle).toBe("idle");
      expect(f.agents("planner")).toHaveLength(0);
      if (reuse) await f.daemon.daemon.agentManager.closeAgent(router.id);
      await f.client.sendMessage(router.id, "Keep old clients working");
      await expect.poll(() => f.agents("planner").length, { timeout: 10_000 }).toBe(1);
      await expect
        .poll(async () => (await f.read()).values.workflows[router.id]?.routed)
        .toBe(true);
      expect((await f.read()).values.workflows[router.id]?.recommendation).toBe("advanced");
      expect(f.prompts.find((prompt) => prompt.role === "planner")?.text).toContain(
        "Keep old clients working",
      );
    } finally {
      await f.close();
    }
  },
  60_000,
);

test("a later plugin hook cannot relax the Router policy before a real creation", async () => {
  const f = await lifecycleFixture();
  try {
    const plugin = path.join(f.directory, "later-hook");
    await mkdir(plugin);
    await writeFile(
      path.join(plugin, "paseo-plugin.json"),
      JSON.stringify({ id: "zzz-later-hook", requirements: { paseo: ">=0.8.0" } }),
    );
    await writeFile(
      path.join(plugin, "index.server.ts"),
      'export default function contribute(server) { server.before("agent.create", ({ request }) => ({ ...request, config: { ...request.config, writePolicy: "read_write" } })); return () => {}; }',
    );
    await f.client.installDirectoryPlugin(plugin);
    await expect(
      f.client.createAgent({
        provider: "codex",
        cwd: f.directory,
        workspaceId: f.workspace.id,
        launchProfileId: "paseo-workflow-router",
        modeId: "full-access",
      }),
    ).rejects.toThrow("cannot relax read_only");
    expect(f.agents("router")).toHaveLength(0);
  } finally {
    await f.close();
  }
}, 60_000);

test("two audits finished during downtime reconcile once, with no repeated manager report", async () => {
  const f = await lifecycleFixture();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.holds.set("audit-deep", held);
  f.holds.set("audit-security", held);
  try {
    f.replies.set("final-review", ['{"classification":"SENSITIVE"}']);
    f.replies.set("audit-deep", ['{"findings":[]}']);
    f.replies.set("audit-security", ['{"findings":[]}']);
    const plan = await pendingPlan(f);
    await f.client.invokePluginRpc("paseo-workflow", "workflow.handoff.prepare.request", plan);
    await publishPlanApproval(f, plan);
    await writeFile(path.join(f.directory, "feature.txt"), "functional\n");
    f.git("add", "feature.txt");
    f.git("commit", "--quiet", "-m", "functional");
    await f.client.sendMessage(plan.agentId, "Implemented and committed");
    await expect
      .poll(
        async () =>
          (await f.read()).values.workflows[plan.agentId]?.plans[plan.callId]?.final?.phase,
      )
      .toBe("auditing");
    await f.client.disablePlugin("paseo-workflow");
    release();
    await expect
      .poll(() => [f.agents("audit-deep")[0]?.lifecycle, f.agents("audit-security")[0]?.lifecycle])
      .toEqual(["idle", "idle"]);
    await f.client.enablePlugin("paseo-workflow");
    for (let pass = 0; pass < 2; pass++) {
      await f.client.reloadPlugin("paseo-workflow");
      await f.client.invokePluginRpc("paseo-workflow", "workflow.status.get.request", {
        agentId: plan.agentId,
        workspaceId: plan.workspaceId,
      });
    }
    expect((await f.read()).values.workflows[plan.agentId]?.plans[plan.callId]?.final?.phase).toBe(
      "complete",
    );
    expect(
      f.prompts.filter((prompt) => prompt.text.startsWith("The audits found no defects")),
    ).toHaveLength(1);
    expect(f.agents("audit-deep")).toHaveLength(1);
    expect(f.agents("audit-security")).toHaveLength(1);
  } finally {
    release();
    await f.close();
  }
}, 60_000);

test("a canceled reviewer is not reconciled as completed after reload", async () => {
  const f = await lifecycleFixture();
  let release!: () => void;
  f.holds.set(
    "plan-reviewer",
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  f.canceled.add("plan-reviewer");
  try {
    const plan = await pendingPlan(f);
    await f.client.invokePluginRpc("paseo-workflow", "workflow.plan.review.request", plan);
    await f.client.disablePlugin("paseo-workflow");
    release();
    await expect.poll(() => f.agents("plan-reviewer")[0]?.lifecycle).toBe("idle");
    const reviewer = f.agents("plan-reviewer")[0]!;
    expect(reviewer.lastCompletedTurnId).toBeUndefined();
    await f.daemon.daemon.agentManager.flush();
    await f.client.enablePlugin("paseo-workflow");
    await f.client.reloadPlugin("paseo-workflow");
    await f.client.invokePluginRpc("paseo-workflow", "workflow.status.get.request", {
      agentId: plan.agentId,
      workspaceId: plan.workspaceId,
    });
    expect((await f.read()).values.workflows[plan.agentId]?.plans[plan.callId]?.review?.phase).toBe(
      "running",
    );
    expect(f.prompts.filter((prompt) => prompt.text.startsWith("Revise the plan"))).toHaveLength(0);
  } finally {
    release();
    await f.close();
  }
}, 60_000);

test.each(["empty", "canceled"] as const)(
  "a %s reviewer can be retried manually with a new prompt ID",
  async (terminal) => {
    const f = await lifecycleFixture();
    f.replies.set("plan-reviewer", [
      terminal === "empty" ? "" : "Do not consume this canceled result",
      "A missing validation must be added",
    ]);
    if (terminal === "canceled") f.canceled.add("plan-reviewer");
    try {
      const plan = await pendingPlan(f);
      await f.client.invokePluginRpc("paseo-workflow", "workflow.plan.review.request", plan);
      await expect.poll(() => f.agents("plan-reviewer")[0]?.lifecycle).toBe("idle");
      expect(f.prompts.filter((prompt) => prompt.text.startsWith("Revise the plan"))).toHaveLength(
        0,
      );
      await expect(
        f.client.respondToPermissionAndWait(plan.agentId, plan.permissionRequestId, {
          behavior: "allow",
        }),
      ).rejects.toThrow("review");
      await expect(
        f.client.invokePluginRpc("paseo-workflow", "workflow.status.get.request", {
          agentId: plan.agentId,
          workspaceId: plan.workspaceId,
        }),
      ).resolves.toMatchObject({ type: "workflow.status.get.response" });
      f.canceled.delete("plan-reviewer");
      const reviewer = f.agents("plan-reviewer")[0]!;
      await f.client.sendMessage(
        reviewer.id,
        "Retry the review of the original plan and conclude",
        { messageId: "manual-review-retry" },
      );
      await expect
        .poll(
          async () =>
            (await f.read()).values.workflows[plan.agentId]?.plans[plan.callId]?.review?.phase,
        )
        .toBe("complete");
      expect(f.prompts.filter((prompt) => prompt.text.startsWith("Revise the plan"))).toHaveLength(
        1,
      );
      expect(f.daemon.daemon.agentManager.getAgent(plan.agentId)!.planReviewClaims).toEqual({});
      await f.client.reloadPlugin("paseo-workflow");
      await f.client.invokePluginRpc("paseo-workflow", "workflow.status.get.request", {
        agentId: plan.agentId,
        workspaceId: plan.workspaceId,
      });
      expect(f.prompts.filter((prompt) => prompt.text.startsWith("Revise the plan"))).toHaveLength(
        1,
      );
      expect(f.agents("plan-reviewer")).toHaveLength(1);
    } finally {
      await f.close();
    }
  },
  60_000,
);

test.each([false, true])(
  "revision admission rechecks after its receipt waits (superseded: %s)",
  async (superseded) => {
    const f = await lifecycleFixture();
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const reviewer = Promise.withResolvers<void>();
    f.holds.set("plan-reviewer", reviewer.promise);
    const send = AgentRequests.prototype.send;
    const intercept = vi
      .spyOn(AgentRequests.prototype, "send")
      .mockImplementation(async function (input) {
        const request = input.request as { text?: string; prompt?: string };
        if ((request.text ?? request.prompt ?? "").startsWith("Revise the plan")) {
          entered.resolve();
          await release.promise;
        }
        return send.call(this, input);
      });
    try {
      const plan = await pendingPlan(f);
      await f.client.invokePluginRpc("paseo-workflow", "workflow.plan.review.request", plan);
      reviewer.resolve();
      await entered.promise;
      const manager = f.daemon.daemon.agentManager;
      let emit: ((event: AgentStreamEvent) => void) | undefined;
      if (superseded) {
        const next = await pendingPlan(f, plan.agentId, "plan-2");
        await f.client.respondToPermissionAndWait(next.agentId, next.permissionRequestId, {
          behavior: "allow",
        });
        const planner = manager.getAgent(plan.agentId)!;
        emit = (
          planner.session as unknown as { notifySubscribers(event: AgentStreamEvent): void }
        ).notifySubscribers.bind(planner.session);
        emit(approvedPlanEntry(next));
        emit({ type: "turn_started", provider: "codex", turnId: "next-implementation" });
        emit({
          type: "timeline",
          provider: "codex",
          turnId: "next-implementation",
          item: { type: "user_message", text: "Implement next plan" },
        });
        await manager.flush();
      }
      release.resolve();
      await expect
        .poll(
          async () =>
            (await f.read()).values.workflows[plan.agentId]?.plans[plan.callId]?.review?.phase,
        )
        .toBe("complete");
      expect(f.prompts.filter(({ text }) => text.startsWith("Revise the plan"))).toHaveLength(
        superseded ? 0 : 1,
      );
      expect(manager.getAgent(plan.agentId)?.planReviewClaims).toEqual({});
      if (superseded)
        expect(manager.getAgent(plan.agentId)?.activeTurnId).toBe("next-implementation");
      await f.client.reloadPlugin("paseo-workflow");
      await f.client.invokePluginRpc("paseo-workflow", "workflow.status.get.request", {
        agentId: plan.agentId,
        workspaceId: plan.workspaceId,
      });
      if (!superseded)
        await expect(
          f.client.sendPlanRevision({
            agentId: plan.agentId,
            workspaceId: plan.workspaceId,
            callId: plan.callId,
            sourcePlanText: plan.text,
            text: f.prompts.find(({ text }) => text.startsWith("Revise the plan"))!.text,
            messageId: `workflow:${plan.agentId}:revision:${plan.callId}`,
          }),
        ).resolves.toBe(true);
      expect(f.prompts.filter(({ text }) => text.startsWith("Revise the plan"))).toHaveLength(
        superseded ? 0 : 1,
      );
      emit?.({ type: "turn_completed", provider: "codex", turnId: "next-implementation" });
    } finally {
      reviewer.resolve();
      release.resolve();
      intercept.mockRestore();
      await f.close();
    }
  },
  60_000,
);

test("subprocess revision admission precedes a concurrent approval without a later interrupt", async () => {
  const f = await lifecycleFixture();
  const reviewer = Promise.withResolvers<void>(),
    readEntered = Promise.withResolvers<void>(),
    readRelease = Promise.withResolvers<void>();
  const sendEntered = Promise.withResolvers<void>(),
    sendRelease = Promise.withResolvers<void>();
  f.holds.set("plan-reviewer", reviewer.promise);
  try {
    const plan = await pendingPlan(f);
    await f.client.invokePluginRpc("paseo-workflow", "workflow.plan.review.request", plan);
    const manager = f.daemon.daemon.agentManager;
    const getRows = manager.getTimelineRows.bind(manager);
    const read = vi.spyOn(manager, "getTimelineRows").mockImplementation(async (...args) => {
      const rows = await getRows(...args);
      if (args[0] === plan.agentId) {
        readEntered.resolve();
        await readRelease.promise;
      }
      return rows;
    });
    const planner = manager.getAgent(plan.agentId)!;
    const start = planner.session.startTurn.bind(planner.session);
    planner.session.startTurn = async (...args) => {
      const result = await start(...args);
      sendEntered.resolve();
      await sendRelease.promise;
      return result;
    };
    const respond = vi.spyOn(planner.session, "respondToPermission");
    const interrupt = vi.spyOn(planner.session, "interrupt");
    reviewer.resolve();
    await readEntered.promise;
    expect(f.prompts.filter(({ text }) => text.startsWith("Revise the plan"))).toHaveLength(0);
    readRelease.resolve();
    await sendEntered.promise;
    const next = {
      ...plan,
      callId: "next-plan",
      permissionRequestId: "next-permission",
      text: "Next plan",
    };
    await manager.appendTimelineItem(planner.id, {
      type: "tool_call",
      callId: next.callId,
      name: "Plan",
      status: "completed",
      error: null,
      detail: { type: "plan", text: next.text },
    });
    planner.pendingPermissions.set(next.permissionRequestId, {
      id: next.permissionRequestId,
      provider: "codex",
      name: "Plan",
      kind: "plan",
      sourcePlanCallId: next.callId,
      input: { plan: next.text },
    });
    const approving = f.client.respondToPermissionAndWait(planner.id, next.permissionRequestId, {
      behavior: "allow",
    });
    expect(respond).not.toHaveBeenCalled();
    sendRelease.resolve();
    await approving;
    await expect
      .poll(
        async () =>
          (await f.read()).values.workflows[plan.agentId]?.plans[plan.callId]?.review?.phase,
      )
      .toBe("complete");
    expect(respond).toHaveBeenCalledOnce();
    expect(interrupt).not.toHaveBeenCalled();
    expect(f.prompts.filter(({ text }) => text.startsWith("Revise the plan"))).toHaveLength(1);
    expect(planner.planReviewClaims).toEqual({});
    read.mockRestore();
    await f.client.reloadPlugin("paseo-workflow");
    await f.client.invokePluginRpc("paseo-workflow", "workflow.status.get.request", {
      agentId: plan.agentId,
      workspaceId: plan.workspaceId,
    });
    expect(f.prompts.filter(({ text }) => text.startsWith("Revise the plan"))).toHaveLength(1);
  } finally {
    reviewer.resolve();
    readRelease.resolve();
    sendRelease.resolve();
    await f.close();
  }
}, 60_000);

test("subprocess replay of a refused revision after a lost reply supersedes the review and releases its claim", async () => {
  const f = await lifecycleFixture();
  const reviewer = Promise.withResolvers<void>(),
    replyLost = Promise.withResolvers<void>();
  f.holds.set("plan-reviewer", reviewer.promise);
  const manager = f.daemon.daemon.agentManager;
  // The host verdict is tested with real timeline races above; here lose that
  // verdict after its journal write, before it can reach the plugin socket.
  const admission = vi.spyOn(manager, "sendPlanRevision").mockResolvedValue(false);
  const send = AgentRequests.prototype.send;
  let loseReply = true;
  const receipt = vi
    .spyOn(AgentRequests.prototype, "send")
    .mockImplementation(async function (input) {
      try {
        return await send.call(this, input);
      } catch (error) {
        if (error instanceof AgentRequestRejectedError && loseReply) {
          loseReply = false;
          replyLost.resolve();
          throw new Error("Revision response lost after durable refusal", { cause: error });
        }
        throw error;
      }
    });
  try {
    const plan = await pendingPlan(f);
    await f.client.invokePluginRpc("paseo-workflow", "workflow.plan.review.request", plan);
    reviewer.resolve();
    await replyLost.promise;
    expect((await f.read()).values.workflows[plan.agentId]?.plans[plan.callId]?.review?.phase).toBe(
      "running",
    );
    await f.client.reloadPlugin("paseo-workflow");
    await f.client.invokePluginRpc("paseo-workflow", "workflow.status.get.request", {
      agentId: plan.agentId,
      workspaceId: plan.workspaceId,
    });
    await expect
      .poll(async () => (await f.read()).values.workflows[plan.agentId]?.plans[plan.callId]?.review)
      .toMatchObject({ phase: "complete", superseded: true });
    expect(admission).toHaveBeenCalledOnce();
    expect(f.prompts.filter(({ text }) => text.startsWith("Revise the plan"))).toHaveLength(0);
    expect(manager.getAgent(plan.agentId)?.planReviewClaims).toEqual({});
    expect(f.agents("plan-reviewer")).toHaveLength(1);
  } finally {
    reviewer.resolve();
    receipt.mockRestore();
    admission.mockRestore();
    await f.close();
  }
}, 60_000);

test("a stale reviewer releases its claim without touching the next implementation turn", async () => {
  const f = await lifecycleFixture();
  let release!: () => void;
  f.holds.set(
    "plan-reviewer",
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  try {
    const plan = await pendingPlan(f);
    await f.client.invokePluginRpc("paseo-workflow", "workflow.plan.review.request", plan);
    const next = await pendingPlan(f, plan.agentId, "plan-2");
    await f.client.respondToPermissionAndWait(next.agentId, next.permissionRequestId, {
      behavior: "allow",
    });
    const manager = f.daemon.daemon.agentManager;
    const planner = manager.getAgent(plan.agentId)!;
    const emit = (
      planner.session as unknown as { notifySubscribers(event: AgentStreamEvent): void }
    ).notifySubscribers.bind(planner.session);
    emit(approvedPlanEntry(next));
    emit({ type: "turn_started", provider: "codex", turnId: "next-implementation" });
    emit({
      type: "timeline",
      provider: "codex",
      turnId: "next-implementation",
      item: { type: "user_message", text: "Implement plan 2", clientMessageId: "implement-next" },
    });
    await manager.flush();
    release();
    await expect
      .poll(
        async () =>
          (await f.read()).values.workflows[plan.agentId]?.plans[plan.callId]?.review?.phase,
      )
      .toBe("complete");
    expect(f.prompts.filter((prompt) => prompt.text.startsWith("Revise the plan"))).toHaveLength(0);
    expect(manager.getAgent(plan.agentId)?.activeTurnId).toBe("next-implementation");
    expect(manager.getAgent(plan.agentId)?.planReviewClaims).toEqual({});
    await f.client.reloadPlugin("paseo-workflow");
    await f.client.invokePluginRpc("paseo-workflow", "workflow.status.get.request", {
      agentId: plan.agentId,
      workspaceId: plan.workspaceId,
    });
    expect(manager.getAgent(plan.agentId)?.activeTurnId).toBe("next-implementation");
    expect(f.prompts.filter((prompt) => prompt.text.startsWith("Revise the plan"))).toHaveLength(0);
    emit({
      type: "timeline",
      provider: "codex",
      turnId: "next-implementation",
      item: { type: "assistant_message", text: "Plan 2 implementation continues" },
    });
    emit({ type: "turn_completed", provider: "codex", turnId: "next-implementation" });
    await manager.flush();
    expect(manager.getAgent(plan.agentId)?.lastCompletedTurnId).toBe("next-implementation");
  } finally {
    release();
    await f.close();
  }
}, 60_000);

test.each([
  ["router", true, "claude"],
  ["executor-standard", true, "claude"],
  ["planner", true, "claude"],
  ["router", true, "codex"],
  ["executor-standard", true, "codex"],
  ["planner", true, "codex"],
  ["router", false, "claude"],
] as const)(
  "daemon restart hydrates completed %s evidence and reconciles once (evidence: %s, native: %s)",
  async (role, hasTurnIds, nativeHistory) => {
    const f = await lifecycleFixture({ providerHistory: true, nativeHistory });
    let releaseFinal!: () => void;
    f.holds.set(
      "final-review",
      new Promise<void>((resolve) => {
        releaseFinal = resolve;
      }),
    );
    try {
      let ownerId: string;
      let planId: string | undefined;
      if (role === "router") {
        const router = await f.client.createAgent({
          provider: "codex",
          cwd: f.directory,
          workspaceId: f.workspace.id,
          launchProfileId: "paseo-workflow-router",
          modeId: "full-access",
        });
        ownerId = router.id;
        f.replies.set("router", [
          '{"ready":true,"recommendation":"standard","constraints":[],"assumptions":[]}',
        ]);
        await f.client.disablePlugin("paseo-workflow");
        await f.client.sendMessage(ownerId, "Build the feature");
      } else {
        const plan = await pendingPlan(f);
        ownerId = plan.agentId;
        planId = plan.callId;
        if (role === "planner") {
          const manager = f.daemon.daemon.agentManager;
          manager.getAgent(ownerId)!.pendingPermissions.clear();
          const source: AgentStreamEvent = {
            type: "timeline",
            provider: "codex",
            turnId: manager.getAgent(ownerId)!.lastCompletedTurnId,
            item: {
              type: "tool_call",
              callId: plan.callId,
              name: "proposal",
              status: "completed",
              error: null,
              detail: { type: "plan", text: plan.text },
            },
          };
          f.providerHistory.get(ownerId)!.push(source);
          await manager.hydrateTimelineFromProvider(ownerId, { force: true });
          const permission = await f.client.ensurePlanPermission({
            agentId: ownerId,
            workspaceId: f.workspace.id,
            callId: plan.callId,
          });
          await f.client.invokePluginRpc("paseo-workflow", "workflow.status.get.request", {
            agentId: ownerId,
            workspaceId: f.workspace.id,
          });
          await f.client.disablePlugin("paseo-workflow");
          f.effects.set("planner", async () => {
            await writeFile(path.join(f.directory, "feature.txt"), "implemented\n");
            f.git("commit", "--quiet", "-am", "functional");
          });
          await f.client.respondToPermissionAndWait(ownerId, permission.id, { behavior: "allow" });
        } else {
          f.replies.set("router", [
            '{"category":"complex","provider":"codex","model":"gpt-6-astra","effort":"high","reason":"Coordinated changes"}',
            "Implemented and committed",
          ]);
          f.effects.set("router", async (text) => {
            if (text.startsWith("/paseo-handoff")) {
              await writeFile(path.join(f.directory, "feature.txt"), "implemented\n");
              f.git("commit", "--quiet", "-am", "functional");
            }
          });
          await f.client.invokePluginRpc("paseo-workflow", "workflow.plan.handoff.request", {
            ...plan,
            selection: "standard",
          });
          await f.client.disablePlugin("paseo-workflow");
        }
      }
      const completedAgent = () =>
        role === "router" || role === "planner"
          ? f.agents(role)[0]
          : f.labelled("executor-complex")[0];
      await expect.poll(() => completedAgent()?.lifecycle).toBe("idle");
      await f.daemon.daemon.agentManager.flush();
      const completed = completedAgent()!.lastCompletedTurnId;
      expect(completed).toBeTruthy();
      if (!hasTurnIds) {
        for (const event of [...f.providerHistory.values()].flat()) {
          if (event.type === "timeline") delete event.turnId;
        }
      }
      await f.restart(hasTurnIds ? undefined : ownerId);
      await f.client.enablePlugin("paseo-workflow");
      const status = () =>
        f.client.invokePluginRpc("paseo-workflow", "workflow.status.get.request", {
          agentId: ownerId,
          workspaceId: f.workspace.id,
        });
      await status();
      await f.client.reloadPlugin("paseo-workflow");
      await status();
      if (role === "router") {
        expect(f.agents("planner")).toHaveLength(hasTurnIds ? 1 : 0);
        expect(
          f.prompts.filter((entry) => entry.text.startsWith("Plan the request interactively")),
        ).toHaveLength(hasTurnIds ? 1 : 0);
      } else {
        expect(
          (await f.read()).values.workflows[ownerId]?.plans[planId!]?.final?.managerId,
          JSON.stringify(
            f.agents(role).map((agent) => ({
              lifecycle: agent.lifecycle,
              completed: agent.lastCompletedTurnId,
            })),
          ),
        ).toBeTruthy();
        expect(f.agents("final-review")).toHaveLength(1);
        expect(f.prompts.filter((entry) => entry.role === "final-review")).toHaveLength(1);
      }
    } finally {
      releaseFinal();
      await f.close();
    }
  },
  60_000,
);

test("the first-party workflow compiles in a real subprocess and installs profiles only by explicit RPC", async () => {
  const daemon = await createTestPaseoDaemon();
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.8.0" });
  const custom = {
    id: "paseo-workflow-router",
    name: "My Router",
    provider: "codex",
    model: "custom-model",
    foreign: { preserve: true },
  };
  try {
    await client.connect();
    await client.patchDaemonConfig({ pluginsEnabled: true, agentProfiles: [custom] });
    await client.installDirectoryPlugin(path.resolve("plugins/paseo-workflow"));
    expect((await client.getDaemonConfig()).config.agentProfiles).toEqual([custom]);
    const result = await client.invokePluginRpc(
      "paseo-workflow",
      "workflow.profiles.install.request",
      {},
    );
    expect(result).toMatchObject({ type: "workflow.profiles.install.response", count: 9 });
    expect((await client.getDaemonConfig()).config.agentProfiles?.[0]).toEqual(custom);
    await client.reloadPlugin("paseo-workflow");
    await client.invokePluginRpc("paseo-workflow", "workflow.profiles.install.request", {});
    expect((await client.getDaemonConfig()).config.agentProfiles).toHaveLength(9);
  } finally {
    await client.close();
    await daemon.close();
  }
}, 60_000);
