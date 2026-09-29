import { describe, expect, it, vi } from "vitest";
import type { Command } from "commander";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

const { connectToDaemon } = vi.hoisted(() => ({ connectToDaemon: vi.fn() }));
vi.mock("../../utils/client.js", () => ({ connectToDaemon }));

import { RestartDrainTimeoutError } from "@getpaseo/client/internal/daemon-client";
import { RestartDrainConflictError } from "@getpaseo/client/internal/daemon-client";
import { runRestartCommand } from "./restart.js";

const daemonTarget = { kind: "endpoint" as const, host: "127.0.0.1:12345" };

function fakeClient(input: {
  pid: number;
  restartServer?: (options: Record<string, unknown>) => Promise<unknown>;
}): DaemonClient {
  return {
    getLastServerInfoMessage: () => ({ serverId: "sid" }),
    getDaemonStatus: async () => ({ pid: input.pid }),
    restartServer: async (
      _reason: string,
      _requestId: string | undefined,
      options: Record<string, unknown>,
    ) => input.restartServer?.(options) ?? { status: "restart_requested" },
    close: async () => {},
  } as unknown as DaemonClient;
}

describe("runRestartCommand", () => {
  it("forwards --wait-idle, parsed --idle-timeout, and --force to the daemon", async () => {
    let captured: Record<string, unknown> | undefined;
    connectToDaemon
      .mockResolvedValueOnce(
        fakeClient({
          pid: 100,
          restartServer: async (options) => {
            captured = options;
            (options.onDrainProgress as (status: unknown) => void)?.({
              runningAgents: ["agent-a"],
            });
            return { status: "restart_requested" };
          },
        }),
      )
      .mockResolvedValueOnce(fakeClient({ pid: 200 }));

    const result = await runRestartCommand(
      {
        daemonTarget,
        waitIdle: true,
        idleTimeout: "1m",
        force: true,
      },
      {} as Command,
    );

    expect(captured).toMatchObject({ waitIdle: true, idleTimeoutMs: 60_000, force: true });
    expect(result.data).toMatchObject({
      action: "restarted",
      workerPid: 200,
      previousWorkerPid: 100,
    });
  });

  it("fails with RESTART_DRAIN_TIMEOUT and never restarts when the drain times out", async () => {
    connectToDaemon.mockResolvedValueOnce(
      fakeClient({
        pid: 100,
        restartServer: async () => {
          throw new RestartDrainTimeoutError(["agent-a"], 150);
        },
      }),
    );

    await expect(
      runRestartCommand({ daemonTarget, waitIdle: true, idleTimeout: "200ms" }, {} as Command),
    ).rejects.toMatchObject({ code: "RESTART_DRAIN_TIMEOUT" });
  });

  it("reports RESTART_DRAIN_IN_PROGRESS when another drain owns the swap", async () => {
    connectToDaemon.mockResolvedValueOnce(
      fakeClient({
        pid: 100,
        restartServer: async () => {
          throw new RestartDrainConflictError(["agent-a"]);
        },
      }),
    );

    await expect(
      runRestartCommand({ daemonTarget, waitIdle: true, idleTimeout: "1m" }, {} as Command),
    ).rejects.toMatchObject({ code: "RESTART_DRAIN_IN_PROGRESS" });
  });

  it("rejects an invalid --idle-timeout before contacting the daemon", async () => {
    connectToDaemon.mockClear();
    await expect(
      runRestartCommand({ daemonTarget, waitIdle: true, idleTimeout: "eventually" }, {} as Command),
    ).rejects.toMatchObject({ code: "INVALID_DURATION" });
    expect(connectToDaemon).not.toHaveBeenCalled();
  });
});
