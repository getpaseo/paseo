import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonConnectionError } from "@getpaseo/client/internal/daemon-client";
import { resolveCallerAgentId as resolveRunCallerAgentId } from "../../utils/caller-agent.js";
import {
  resolveExistingRunPlacement,
  resolveExistingRunWorkspace,
  resolveRunFeatureValues,
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
      return { agent: { id: agentId } };
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

describe("run feature values", () => {
  const draft = { provider: "codex", cwd: "/repo", model: "gpt-5.5", thinkingOptionId: "high" };
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

  function featureDaemon(models: Array<{ id: string; isDefault?: boolean }> = []) {
    const featureDrafts: unknown[] = [];
    const modelLookups: unknown[] = [];
    return {
      featureDrafts,
      modelLookups,
      async listProviderModels(provider: string, options: { cwd: string }) {
        modelLookups.push({ provider, ...options });
        return { models };
      },
      async listProviderFeatures(draftConfig: unknown) {
        featureDrafts.push(draftConfig);
        return { features: [serviceTier] };
      },
    };
  }

  it("does not ask the daemon when no --feature is given", async () => {
    const client = {
      async listProviderModels(): Promise<never> {
        throw new Error("unexpected model lookup");
      },
      async listProviderFeatures(): Promise<never> {
        throw new Error("unexpected feature lookup");
      },
    };

    await expect(resolveRunFeatureValues(client, {}, draft)).resolves.toBeUndefined();
  });

  it("checks values against the features of the run's provider and model", async () => {
    const client = featureDaemon();

    await expect(
      resolveRunFeatureValues(client, { service_tier: "priority" }, draft),
    ).resolves.toEqual({ service_tier: "priority" });
    expect(client.featureDrafts).toEqual([draft]);
    expect(client.modelLookups).toEqual([]);
  });

  it("checks a run without --model against the model the daemon will default to", async () => {
    const client = featureDaemon([{ id: "gpt-5.4" }, { id: "gpt-5.5", isDefault: true }]);
    const { model: _model, ...withoutModel } = draft;

    await expect(
      resolveRunFeatureValues(client, { service_tier: "priority" }, withoutModel),
    ).resolves.toEqual({ service_tier: "priority" });
    expect(client.modelLookups).toEqual([{ provider: "codex", cwd: "/repo" }]);
    expect(client.featureDrafts).toEqual([{ ...withoutModel, model: "gpt-5.5" }]);
  });

  it("falls back to the first listed model when none is marked default", async () => {
    const client = featureDaemon([{ id: "gpt-5.4" }, { id: "gpt-5.5" }]);
    const { model: _model, ...withoutModel } = draft;

    await resolveRunFeatureValues(client, { service_tier: "priority" }, withoutModel);
    expect(client.featureDrafts).toEqual([{ ...withoutModel, model: "gpt-5.4" }]);
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
      resolveRunFeatureValues(client, { service_tier: "priority" }, draft),
    ).rejects.toMatchObject({
      code: "FEATURES_UNAVAILABLE",
      message: "Could not list features for codex: provider unavailable",
    });
  });
});

describe("existing run placement", () => {
  const originalWorkspaceId = process.env.PASEO_WORKSPACE_ID;
  afterEach(() => {
    if (originalWorkspaceId === undefined) delete process.env.PASEO_WORKSPACE_ID;
    else process.env.PASEO_WORKSPACE_ID = originalWorkspaceId;
  });

  it("uses an explicit workspace's directory, not the shell's", async () => {
    const fetchWorkspaces = vi.fn().mockResolvedValue({
      entries: [{ id: "workspace-2", workspaceDirectory: "/remote/repo" }],
      pageInfo: { nextCursor: null },
    });

    await expect(
      resolveExistingRunPlacement(
        { fetchWorkspaces },
        { workspace: "workspace-2" },
        "/local/shell",
        undefined,
      ),
    ).resolves.toEqual({ id: "workspace-2", cwd: "/remote/repo" });
  });

  it("leaves a run that needs a new workspace unplaced", async () => {
    delete process.env.PASEO_WORKSPACE_ID;
    const fetchWorkspaces = vi.fn();

    await expect(
      resolveExistingRunPlacement({ fetchWorkspaces }, {}, "/local/shell", undefined),
    ).resolves.toBeUndefined();
    expect(fetchWorkspaces).not.toHaveBeenCalled();
  });
});
