import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonConnectionError } from "@getpaseo/client/internal/daemon-client";
import { resolveCallerAgentId as resolveRunCallerAgentId } from "../../utils/caller-agent.js";
import {
  buildRunAgentRequest,
  prepareRun,
  resolveExistingRunWorkspace,
  resolveRunFeatureValues,
  type RunModelEntry,
  type RunPreparationClient,
  runRunCommand,
  waitsForFinish,
  type AgentRunOptions,
} from "./run";

const daemonTarget = { kind: "endpoint" as const, host: "example.test:12345" };

// Answers fetchAgent the way a daemon does: an unknown id is an error.
function daemonWithAgents(...agentIds: string[]) {
  return {
    async fetchAgent({ agentId }: { agentId: string }) {
      if (!agentIds.includes(agentId)) {
        throw new Error(`Agent not found: ${agentId}`);
      }
      return { agent: { id: agentId, cwd: `/agents/${agentId}` } };
    },
  };
}

describe("run wait policy", () => {
  it("waits by default and stops waiting on --no-wait or a legacy alias", () => {
    expect(waitsForFinish({})).toBe(true);
    expect(waitsForFinish({ wait: false })).toBe(false);
    expect(waitsForFinish({ background: true })).toBe(false);
    expect(waitsForFinish({ detach: true })).toBe(false);
  });
});

describe("managed agent caller context", () => {
  it("uses a trimmed PASEO_AGENT_ID when the target daemon runs that agent", async () => {
    await expect(
      resolveRunCallerAgentId(daemonWithAgents("parent-agent"), {
        PASEO_AGENT_ID: "  parent-agent  ",
      }),
    ).resolves.toBe("parent-agent");
  });

  it("runs without a caller when PASEO_AGENT_ID belongs to another daemon", async () => {
    await expect(
      resolveRunCallerAgentId(daemonWithAgents("other-agent"), {
        PASEO_AGENT_ID: "parent-agent",
      }),
    ).resolves.toBeUndefined();
  });

  it.each(["DAEMON_CONNECTION_LOST", "DAEMON_REQUEST_TIMEOUT"] as const)(
    "preserves %s instead of dropping the caller",
    async (code) => {
      const disconnectedDaemon = {
        async fetchAgent(): Promise<never> {
          throw new DaemonConnectionError("Caller lookup transport failed", code);
        },
      };

      await expect(
        resolveRunCallerAgentId(disconnectedDaemon, { PASEO_AGENT_ID: "parent-agent" }),
      ).rejects.toBeInstanceOf(DaemonConnectionError);
    },
  );

  it("omits blank caller ids", async () => {
    await expect(
      resolveRunCallerAgentId(daemonWithAgents(), { PASEO_AGENT_ID: "   " }),
    ).resolves.toBeUndefined();
  });
});

describe("existing run workspace resolution", () => {
  it("queries the daemon for an exact workspace id and uses its directory", async () => {
    const fetchWorkspaces = vi.fn().mockResolvedValue({
      entries: [{ id: "workspace-2", workspaceDirectory: "/workspace/two" }],
      pageInfo: { nextCursor: null },
    });

    await expect(resolveExistingRunWorkspace({ fetchWorkspaces }, "workspace-2")).resolves.toEqual({
      id: "workspace-2",
      cwd: "/workspace/two",
    });
    expect(fetchWorkspaces).toHaveBeenCalledWith({
      filter: { query: "workspace-2" },
      page: { limit: 200 },
    });
  });

  it("rejects a workspace id absent from daemon state", async () => {
    const fetchWorkspaces = vi.fn().mockResolvedValue({
      entries: [],
      pageInfo: { nextCursor: null },
    });

    await expect(resolveExistingRunWorkspace({ fetchWorkspaces }, "missing")).rejects.toMatchObject(
      {
        code: "WORKSPACE_NOT_FOUND",
        message: "Workspace not found: missing",
      },
    );
  });
});

// validateRunOptions runs before the CLI ever connects to a daemon, so these
// invalid combinations reject without one running.
describe("runRunCommand option validation", () => {
  const originalWorkspaceId = process.env.PASEO_WORKSPACE_ID;

  beforeEach(() => {
    delete process.env.PASEO_WORKSPACE_ID;
  });

  afterEach(() => {
    if (originalWorkspaceId === undefined) {
      delete process.env.PASEO_WORKSPACE_ID;
    } else {
      process.env.PASEO_WORKSPACE_ID = originalWorkspaceId;
    }
  });

  async function expectInvalidOptions(
    options: Omit<AgentRunOptions, "daemonTarget">,
    messageMatch: RegExp,
  ) {
    await expect(
      runRunCommand("do something", { ...options, daemonTarget }, {} as never),
    ).rejects.toMatchObject({
      code: "INVALID_OPTIONS",
      message: expect.stringMatching(messageMatch),
    });
  }

  it("rejects --new-workspace combined with --workspace", async () => {
    await expectInvalidOptions(
      { newWorkspace: "worktree", workspace: "ws-1" },
      /--new-workspace and --workspace cannot be combined/,
    );
  });

  it("allows explicit worktree workspace creation through validation", async () => {
    // Explicit workspace creation with no --workspace
    // must clear validation. It still fails later (provider resolution), which
    // is enough to prove the new guard did not reject it.
    await expect(
      runRunCommand(
        "do something",
        { newWorkspace: "worktree", provider: undefined, daemonTarget },
        {} as never,
      ),
    ).rejects.not.toMatchObject({ code: "INVALID_OPTIONS" });
  });

  it("rejects unknown new workspace kinds", async () => {
    await expectInvalidOptions({ newWorkspace: "container" }, /Unsupported new workspace kind/);
  });

  it("rejects two workspace creation flags", async () => {
    await expectInvalidOptions(
      { newWorkspace: "local", worktree: "legacy-slug" },
      /--new-workspace and --worktree cannot be combined/,
    );
  });

  it("rejects an unknown worktree creation mode before connecting", async () => {
    await expectInvalidOptions(
      { newWorkspace: "worktree", worktreeMode: "container" },
      /Unsupported worktree mode/,
    );
  });
});

const serviceTier = {
  type: "select" as const,
  id: "service_tier",
  label: "Speed",
  value: "default",
  options: [
    { id: "default", label: "Normal" },
    { id: "priority", label: "Fast" },
  ],
};

// A daemon with one workspace and Codex-like features. It records what feature discovery was asked
// and offers no way to create anything, so preparation cannot leave a workspace or agent behind.
class PreparationDaemon implements RunPreparationClient {
  readonly modelLookups: Array<{ provider: string; cwd: string }> = [];
  readonly featureDrafts: unknown[] = [];

  constructor(private readonly models: RunModelEntry[] = []) {}

  async fetchWorkspaces() {
    return {
      entries: [{ id: "workspace-2", workspaceDirectory: "/remote/repo" }],
      pageInfo: { nextCursor: null },
    };
  }

  async listProviderModels(provider: string, options: { cwd: string }) {
    this.modelLookups.push({ provider, cwd: options.cwd });
    return { models: this.models };
  }

  async listProviderFeatures(draftConfig: unknown) {
    this.featureDrafts.push(draftConfig);
    return { features: [serviceTier] };
  }
}

describe("run preparation", () => {
  const originalWorkspaceId = process.env.PASEO_WORKSPACE_ID;
  afterEach(() => {
    if (originalWorkspaceId === undefined) delete process.env.PASEO_WORKSPACE_ID;
    else process.env.PASEO_WORKSPACE_ID = originalWorkspaceId;
  });

  const draft = {
    provider: "codex",
    model: "gpt-5.5",
    modeId: undefined,
    thinkingOptionId: "high",
  };
  const fast = { service_tier: "priority" };
  const caller = { id: "parent-agent", cwd: "/caller/workspace" };

  it("checks features in an explicit workspace's directory, not the shell's", async () => {
    const daemon = new PreparationDaemon();

    const prepared = await prepareRun(daemon, {
      options: { workspace: "workspace-2" },
      cwd: "/local/shell",
      caller: undefined,
      requestedFeatures: fast,
      draft,
    });

    expect(prepared).toEqual({
      placement: { id: "workspace-2", cwd: "/remote/repo" },
      featureValues: { service_tier: "priority" },
    });
    expect(daemon.featureDrafts).toEqual([{ ...draft, cwd: "/remote/repo" }]);
  });

  it("checks a subagent's features in its caller's directory, ahead of an ambient workspace", async () => {
    process.env.PASEO_WORKSPACE_ID = "workspace-2";
    const daemon = new PreparationDaemon();

    const prepared = await prepareRun(daemon, {
      options: {},
      cwd: "/local/shell",
      caller,
      requestedFeatures: fast,
      draft,
    });

    expect(prepared.placement).toEqual({ cwd: "/caller/workspace" });
    expect(daemon.featureDrafts).toEqual([{ ...draft, cwd: "/caller/workspace" }]);
  });

  it("checks a run that needs a new workspace in the shell's directory and leaves it unplaced", async () => {
    delete process.env.PASEO_WORKSPACE_ID;
    const daemon = new PreparationDaemon();

    const prepared = await prepareRun(daemon, {
      options: { newWorkspace: "worktree" },
      cwd: "/local/shell",
      caller,
      requestedFeatures: fast,
      draft,
    });

    expect(prepared.placement).toBeUndefined();
    expect(daemon.featureDrafts).toEqual([{ ...draft, cwd: "/local/shell" }]);
  });

  it("rejects an unknown feature before any workspace or agent exists", async () => {
    const daemon = new PreparationDaemon();

    await expect(
      prepareRun(daemon, {
        options: {},
        cwd: "/local/shell",
        caller: undefined,
        requestedFeatures: { fast_mode: "true" },
        draft,
      }),
    ).rejects.toMatchObject({ code: "INVALID_FEATURE", message: "Unknown feature: fast_mode" });
  });

  it("asks the daemon nothing about features without --feature", async () => {
    const daemon = new PreparationDaemon();

    const prepared = await prepareRun(daemon, {
      options: {},
      cwd: "/local/shell",
      caller: undefined,
      requestedFeatures: {},
      draft,
    });

    expect(prepared.featureValues).toBeUndefined();
    expect(daemon.modelLookups).toEqual([]);
    expect(daemon.featureDrafts).toEqual([]);
  });
});

describe("run feature values", () => {
  const draft = { provider: "codex", cwd: "/repo", thinkingOptionId: "high" };
  const models = [{ id: "gpt-5.4" }, { id: "gpt-5.5", isDefault: true }];

  it("checks an explicit model without listing models", async () => {
    const daemon = new PreparationDaemon(models);

    await resolveRunFeatureValues(
      daemon,
      { service_tier: "priority" },
      { ...draft, model: "gpt-5.4" },
    );
    expect(daemon.modelLookups).toEqual([]);
    expect(daemon.featureDrafts).toEqual([{ ...draft, model: "gpt-5.4" }]);
  });

  it.each([undefined, "default", " default "])(
    "checks model %j against the model the daemon defaults to",
    async (model) => {
      const daemon = new PreparationDaemon(models);

      await expect(
        resolveRunFeatureValues(daemon, { service_tier: "priority" }, { ...draft, model }),
      ).resolves.toEqual({ service_tier: "priority" });
      expect(daemon.modelLookups).toEqual([{ provider: "codex", cwd: "/repo" }]);
      expect(daemon.featureDrafts).toEqual([{ ...draft, model: "gpt-5.5" }]);
    },
  );

  it("falls back to the first listed model when none is marked default", async () => {
    const daemon = new PreparationDaemon([{ id: "gpt-5.4" }, { id: "gpt-5.5" }]);

    await resolveRunFeatureValues(daemon, { service_tier: "priority" }, draft);
    expect(daemon.featureDrafts).toEqual([{ ...draft, model: "gpt-5.4" }]);
  });

  it("reports a provider that cannot list its features", async () => {
    const client = {
      async listProviderModels() {
        return { models: [] };
      },
      async listProviderFeatures() {
        return { error: "provider unavailable" };
      },
    };

    await expect(
      resolveRunFeatureValues(client, { service_tier: "priority" }, { ...draft, model: "gpt-5.5" }),
    ).rejects.toMatchObject({
      code: "FEATURES_UNAVAILABLE",
      message: "Could not list features for codex: provider unavailable",
    });
  });
});

describe("run agent request", () => {
  it("carries the checked feature values and the resolved placement", () => {
    expect(
      buildRunAgentRequest({
        provider: "codex",
        model: undefined,
        modeId: "full-access",
        thinkingOptionId: "high",
        featureValues: { service_tier: "priority" },
        workspace: { id: "workspace-2", cwd: "/remote/repo" },
        callerAgentId: "parent-agent",
        title: "Task",
        images: undefined,
        env: undefined,
        labels: {},
      }),
    ).toEqual({
      provider: "codex",
      cwd: "/remote/repo",
      workspaceId: "workspace-2",
      callerAgentId: "parent-agent",
      title: "Task",
      modeId: "full-access",
      model: undefined,
      thinkingOptionId: "high",
      featureValues: { service_tier: "priority" },
      images: undefined,
      env: undefined,
      labels: undefined,
    });
  });
});
