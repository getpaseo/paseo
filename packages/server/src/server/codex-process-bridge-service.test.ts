import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
  readlink: vi.fn(async (path: string) => {
    if (path === "/proc/1831379/cwd" || path === "/proc/1832000/cwd") {
      return "/workspace/repo-b";
    }
    throw new Error(`Unexpected readlink call: ${path}`);
  }),
}));

import { CodexProcessBridgeService } from "./codex-process-bridge-service.js";

function createLogger() {
  const logger = {
    child: vi.fn(() => logger),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger;
}

const activeServices: CodexProcessBridgeService[] = [];

function createService(options?: { missingScanGrace?: number }) {
  const state = {
    psOutput:
      "1831372 621663 pts/14 node /usr/local/bin/codex resume 019d6145-173e-74a0-88bc-e34f12bd3941\n1831379 1831372 pts/14 /opt/codex/codex resume 019d6145-173e-74a0-88bc-e34f12bd3941\n",
  };
  const liveAgentIds = new Set<string>();
  const runner = {
    execFile: vi.fn(async (file: string, args: string[]) => {
      if (file === "ps" && args.join(" ") === "-eo pid=,ppid=,tty=,args=") {
        return state.psOutput;
      }
      if (file === "ps" && args[0] === "-p") {
        return state.psOutput.includes(`${args[1]} `) ? String(args[1]) : "";
      }
      if (file === "python3") {
        return "";
      }
      if (file === "tail") {
        return "existing output";
      }
      throw new Error(`Unexpected execFile call: ${file} ${args.join(" ")}`);
    }),
  };

  const adoptSession = vi.fn(async (_session, _config, agentId: string) => {
    liveAgentIds.add(agentId);
    return { id: agentId };
  });
  const closeAgent = vi.fn(async (agentId: string) => {
    liveAgentIds.delete(agentId);
  });
  const getAgent = vi.fn((agentId: string) => (liveAgentIds.has(agentId) ? { id: agentId } : null));

  const service = new CodexProcessBridgeService({
    logger: createLogger() as any,
    paseoHome: "/tmp/paseo-test",
    agentManager: {
      adoptSession,
      closeAgent,
      getAgent,
    } as any,
    projectRegistry: { upsert: vi.fn(async () => {}) } as any,
    workspaceRegistry: { upsert: vi.fn(async () => {}) } as any,
    runner: runner as any,
    scanIntervalMs: 60_000,
    missingScanGrace: options?.missingScanGrace ?? 2,
  });
  activeServices.push(service);

  return { service, state, adoptSession, closeAgent };
}

afterEach(async () => {
  await Promise.all(activeServices.splice(0).map((service) => service.stop()));
});

describe("CodexProcessBridgeService", () => {
  it("adopts live tty-backed codex processes into the agent manager", async () => {
    const { service, adoptSession } = createService();

    await service.syncNow();

    expect(adoptSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        provider: "codex",
        cwd: "/workspace/repo-b",
        title: "repo-b [pts/14]",
      }),
      expect.any(String),
      expect.objectContaining({
        labels: {
          source: "external",
          bridge: "codex_process",
          tty: "pts/14",
        },
      }),
    );
  });

  it("closes tracked sessions once the process disappears for long enough", async () => {
    const { service, state, adoptSession, closeAgent } = createService({ missingScanGrace: 1 });

    await service.syncNow();
    const adoptedAgentId = adoptSession.mock.calls[0]?.[2];

    state.psOutput = "";
    await service.syncNow();

    expect(closeAgent).toHaveBeenCalledWith(adoptedAgentId);
  });

  it("resumes a persisted codex process session under the supplied agent id", async () => {
    const { service, adoptSession } = createService();

    await service.resumeFromPersistence({
      handle: {
        provider: "codex",
        sessionId: "019d6145-173e-74a0-88bc-e34f12bd3941",
        metadata: {
          externalSessionSource: "codex_process",
          tty: "/dev/pts/14",
          cwd: "/workspace/repo-b",
          sessionId: "019d6145-173e-74a0-88bc-e34f12bd3941",
        },
      },
      agentId: "agent-external-resumed",
      config: {
        provider: "codex",
        cwd: "/workspace/repo-b",
        modeId: "auto",
        title: "repo-b [pts/14]",
      },
      labels: {
        source: "external",
        bridge: "codex_process",
        tty: "pts/14",
      },
    });

    expect(adoptSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        provider: "codex",
        cwd: "/workspace/repo-b",
        title: "repo-b [pts/14]",
      }),
      "agent-external-resumed",
      expect.objectContaining({
        labels: {
          source: "external",
          bridge: "codex_process",
          tty: "pts/14",
        },
      }),
    );
  });

  it("treats a tty-reused no-session codex process as a new external session", async () => {
    const { service, state, adoptSession, closeAgent } = createService({ missingScanGrace: 1 });

    state.psOutput =
      "1831379 621663 pts/14 /opt/codex/codex --no-alt-screen\n";
    await service.syncNow();

    const firstAgentId = adoptSession.mock.calls[0]?.[2];

    state.psOutput =
      "1832000 621663 pts/14 /opt/codex/codex --no-alt-screen\n";
    await service.syncNow();

    const secondAgentId = adoptSession.mock.calls[1]?.[2];

    expect(adoptSession).toHaveBeenCalledTimes(2);
    expect(firstAgentId).not.toBe(secondAgentId);
    expect(closeAgent).toHaveBeenCalledWith(firstAgentId);
  });

  it("does not resume a different no-session codex process only because the tty matches", async () => {
    const { service, adoptSession, state } = createService();

    state.psOutput =
      "1832000 621663 pts/14 /opt/codex/codex --no-alt-screen\n";

    await expect(
      service.resumeFromPersistence({
        handle: {
          provider: "codex",
          sessionId: "/dev/pts/14",
          metadata: {
            externalSessionSource: "codex_process",
            tty: "/dev/pts/14",
            cwd: "/workspace/repo-b",
            leaderPid: 1831379,
            sessionId: null,
          },
        },
        agentId: "agent-external-resumed",
        config: {
          provider: "codex",
          cwd: "/workspace/repo-b",
          modeId: "auto",
          title: "repo-b [pts/14]",
        },
        labels: {
          source: "external",
          bridge: "codex_process",
          tty: "pts/14",
        },
      }),
    ).rejects.toThrow("codex process session not found");

    expect(adoptSession).not.toHaveBeenCalled();
  });
});
