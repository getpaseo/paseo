import { afterEach, describe, expect, it, vi } from "vitest";

import { TmuxCodexBridgeService } from "./tmux-codex-bridge-service.js";
import type { StoredAgentRecord } from "./agent/agent-storage.js";

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

const activeServices: TmuxCodexBridgeService[] = [];

function createStoredRecord(input: {
  id: string;
  title: string;
  labels: Record<string, string>;
  createdAt?: string;
  updatedAt?: string;
  lastUserMessageAt?: string | null;
  paneId?: string | null;
  lastStatus?: StoredAgentRecord["lastStatus"];
  cwd?: string;
}): StoredAgentRecord {
  const createdAt = input.createdAt ?? "2026-04-12T00:00:00.000Z";
  const updatedAt = input.updatedAt ?? createdAt;
  const paneId = input.paneId ?? "%42";
  const cwd = input.cwd ?? "/workspace/project";

  return {
    id: input.id,
    provider: "codex",
    cwd,
    createdAt,
    updatedAt,
    lastActivityAt: updatedAt,
    lastUserMessageAt: input.lastUserMessageAt ?? null,
    title: input.title,
    labels: input.labels,
    lastStatus: input.lastStatus ?? "closed",
    lastModeId: "auto",
    config: {
      title: input.title,
      modeId: "auto",
      extra: paneId
        ? {
            codex: {
              externalSessionSource: "tmux_codex",
              paneId,
            },
          }
        : undefined,
    },
    runtimeInfo: paneId
      ? {
          provider: "codex",
          sessionId: paneId,
          modeId: "auto",
          extra: {
            externalSessionSource: "tmux_codex",
            paneId,
          },
        }
      : undefined,
    features: [],
    persistence: paneId
      ? {
          provider: "codex",
          sessionId: paneId,
          metadata: {
            externalSessionSource: "tmux_codex",
            paneId,
            cwd,
          },
        }
      : null,
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    internal: false,
  };
}

function createRunnerMock(params: {
  processArgs?: string;
  listPanesOutput?: string;
  psOutput?: string;
  paneId?: string;
  cwd?: string;
  title?: string;
}) {
  const paneId = params.paneId ?? "%42";
  const cwd = params.cwd ?? "/workspace/project";
  const title = params.title ?? "";
  const state = {
    listPanesOutput:
      params.listPanesOutput ??
      `${paneId}\tworkspace-a\t@1\t${title}\t1001\t/dev/pts/21\t${cwd}\n`,
    psOutput:
      params.psOutput ??
      `1001 1 tmux: server\n1002 1001 ${params.processArgs ?? "/usr/local/bin/codex-root-wrapper resume 019d7f5b-1d2c-76c2-96e9-0a6496559b68"}\n1003 1002 /opt/codex/codex resume 019d7f5b-1d2c-76c2-96e9-0a6496559b68\n`,
  };
  const calls: Array<{ file: string; args: string[] }> = [];
  const runner = {
    execFile: vi.fn(async (file: string, args: string[]) => {
      calls.push({ file, args });

      if (file === "tmux" && args[0] === "new-session") {
        return `${paneId}\n`;
      }
      if (file === "tmux" && args[0] === "select-pane") {
        return "";
      }
      if (file === "tmux" && args[0] === "capture-pane") {
        return "existing output";
      }
      if (file === "tmux" && args[0] === "send-keys") {
        return "";
      }
      if (file === "tmux" && args[0] === "list-panes") {
        return state.listPanesOutput;
      }
      if (file === "ps" && args.join(" ") === "-eo pid=,ppid=,args=") {
        return state.psOutput;
      }
      if (file === "ps" && args[0] === "-p") {
        return String(args[1]);
      }

      throw new Error(`Unexpected execFile call: ${file} ${args.join(" ")}`);
    }),
  };

  return { runner, calls, state };
}

function createService(params: {
  processArgs?: string;
  listPanesOutput?: string;
  psOutput?: string;
  storedRecords?: StoredAgentRecord[];
  getAgent?: (agentId: string) => { id: string } | null;
  paneId?: string;
  cwd?: string;
  title?: string;
}) {
  const { runner, calls, state } = createRunnerMock(params);
  const adoptSession = vi.fn(async (_session, _config, agentId: string) => ({
    id: agentId,
  }));
  const setTitle = vi.fn(async (_agentId: string, _title: string) => {});
  const upsert = vi.fn(async (_record: StoredAgentRecord) => {});
  const remove = vi.fn(async (_agentId: string) => {});
  const closeAgent = vi.fn(async (_agentId: string) => {});
  const getAgent = vi.fn((agentId: string) => params.getAgent?.(agentId) ?? null);

  const service = new TmuxCodexBridgeService({
    logger: createLogger() as any,
    paseoHome: "/tmp/paseo-test",
    agentManager: {
      adoptSession,
      setTitle,
      getAgent,
      closeAgent,
    } as any,
    agentStorage: {
      list: vi.fn(async () => params.storedRecords ?? []),
      upsert,
      remove,
    } as any,
    projectRegistry: {
      upsert: async () => {},
    } as any,
    workspaceRegistry: {
      upsert: async () => {},
    } as any,
    runner: runner as any,
  });
  activeServices.push(service);

  return { service, adoptSession, setTitle, calls, state, remove, upsert, closeAgent, getAgent };
}

afterEach(async () => {
  await Promise.all(activeServices.splice(0).map((service) => service.stop()));
});

describe("TmuxCodexBridgeService", () => {
  it("adopts live tmux codex panes into the agent manager", async () => {
    const { service, adoptSession } = createService({});

    await service.syncNow();

    expect(adoptSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        provider: "codex",
        cwd: "/workspace/project",
        title: "project [tmux:%42]",
      }),
      expect.any(String),
      expect.objectContaining({
        labels: {
          source: "tmux",
          bridge: "codex",
          pane: "%42",
        },
      }),
    );
  });

  it("adopts a tmux pane under the canonical persisted external agent id and removes tmux duplicates", async () => {
    const { service, adoptSession, remove } = createService({
      storedRecords: [
        createStoredRecord({
          id: "agent-external",
          title: "project [pts/23]",
          labels: { source: "external", bridge: "codex_process", tty: "pts/23" },
          createdAt: "2026-04-12T04:19:40.582Z",
          updatedAt: "2026-04-12T11:22:28.647Z",
        }),
        createStoredRecord({
          id: "agent-tmux",
          title: "project [tmux:%42]",
          labels: { source: "tmux", bridge: "codex", pane: "%42" },
          createdAt: "2026-04-12T11:22:30.000Z",
          updatedAt: "2026-04-12T11:22:30.000Z",
        }),
      ],
    });

    await service.syncNow();

    expect(adoptSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        provider: "codex",
        cwd: "/workspace/project",
        title: "project [pts/23]",
      }),
      "agent-external",
      expect.objectContaining({
        labels: { source: "external", bridge: "codex_process", tty: "pts/23" },
      }),
    );
    expect(remove).toHaveBeenCalledWith("agent-tmux");
  });

  it("refreshes generated tmux fallback titles from the live pane title", async () => {
    const { service, adoptSession, setTitle } = createService({
      listPanesOutput:
        "%42\tworkspace-a\t@1\tPASEO_RENAMED_20260413\t1001\t/dev/pts/21\t/workspace/project\n",
      storedRecords: [
        createStoredRecord({
          id: "agent-tmux",
          title: "project [tmux:%42]",
          labels: { source: "tmux", bridge: "codex", pane: "%42" },
        }),
      ],
    });

    await service.syncNow();

    expect(adoptSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        provider: "codex",
        cwd: "/workspace/project",
        title: "PASEO_RENAMED_20260413",
      }),
      "agent-tmux",
      expect.objectContaining({
        labels: { source: "tmux", bridge: "codex", pane: "%42" },
      }),
    );
    expect(setTitle).toHaveBeenCalledWith("agent-tmux", "PASEO_RENAMED_20260413");
  });

  it("marks persisted tmux sessions closed when their pane is missing after restart", async () => {
    const record = createStoredRecord({
      id: "agent-external",
      title: "project [pts/15]",
      labels: { source: "external", bridge: "codex_process", tty: "pts/15" },
      paneId: "%8",
      lastStatus: "idle",
    });
    const { service, upsert, closeAgent } = createService({
      listPanesOutput: "",
      psOutput: "",
      storedRecords: [record],
    });

    await service.start();

    expect(closeAgent).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "agent-external",
        lastStatus: "closed",
      }),
    );
  });

  it("relaunches via codex resume when a recoverable session id exists", async () => {
    const { service, adoptSession, calls } = createService({
      processArgs: "/usr/local/bin/codex-root-wrapper resume 019d6145-173e-74a0-88bc-e34f12bd3941",
      title: "project [pts/23]",
    });

    await service.relaunchFromPersistence({
      handle: {
        provider: "codex",
        sessionId: "/dev/pts/23",
        metadata: {
          externalSessionSource: "codex_process",
          cwd: "/workspace/project",
          sessionId: "019d6145-173e-74a0-88bc-e34f12bd3941",
        },
      },
      agentId: "agent-1",
      config: {
        provider: "codex",
        cwd: "/workspace/project",
        modeId: "auto",
        title: "project [pts/23]",
      },
    });

    expect(
      calls.some(
        (call) =>
          call.file === "tmux" &&
          call.args[0] === "new-session" &&
          call.args.includes("/usr/local/bin/codex-root-wrapper") &&
          call.args.includes("resume") &&
          call.args.includes("019d6145-173e-74a0-88bc-e34f12bd3941"),
      ),
    ).toBe(true);
    expect(adoptSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        provider: "codex",
        cwd: "/workspace/project",
        title: "project [pts/23]",
      }),
      "agent-1",
      expect.anything(),
    );
  });
});
