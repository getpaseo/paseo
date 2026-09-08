import { describe, expect, it, vi } from "vitest";
import type { Command } from "commander";
import { runRestartCommand, type RestartCommandDependencies } from "./restart";

function makeDependencies(input?: {
  env?: NodeJS.ProcessEnv;
  currentHome?: string;
  targetHome?: string;
}) {
  const restartServer = vi.fn(async () => undefined);
  const close = vi.fn(async () => undefined);
  const connectToDaemon = vi.fn(async () => ({ restartServer, close }));
  const stopLocalDaemon = vi.fn(async () => ({
    action: "stopped" as const,
    home: input?.targetHome ?? "/tmp/paseo",
    pid: 100,
    forced: false,
    usedLifecycleRpc: true,
    reason: "lifecycle_shutdown_rpc" as const,
    message: "Daemon stopped gracefully",
  }));
  const startLocalDaemonDetached = vi.fn(async () => ({
    pid: 200,
    logPath: "/tmp/paseo/daemon.log",
  }));
  const currentHome = input?.currentHome ?? "/tmp/paseo";
  const targetHome = input?.targetHome ?? currentHome;
  const dependencies: RestartCommandDependencies = {
    env: input?.env ?? {},
    connectToDaemon,
    resolveLocalDaemonState: () => ({
      home: targetHome,
      listen: "127.0.0.1:6767",
      relayEnabled: false,
      relayEndpoint: "relay.paseo.sh:443",
      relayUseTls: true,
      relayPublicUseTls: true,
      logPath: `${targetHome}/daemon.log`,
      pidPath: `${targetHome}/paseo.pid`,
      pidInfo: { pid: 100, listen: "127.0.0.1:6767" },
      running: true,
      stalePidFile: false,
    }),
    resolveLocalPaseoHome: (home) => home ?? currentHome,
    startLocalDaemonDetached,
    stopLocalDaemon,
  };
  return {
    dependencies,
    restartServer,
    close,
    connectToDaemon,
    stopLocalDaemon,
    startLocalDaemonDetached,
  };
}

describe("runRestartCommand", () => {
  it("recycles the supervised worker when called by an agent owned by that daemon", async () => {
    const fake = makeDependencies({ env: { PASEO_AGENT_ID: "agent-1" } });

    const result = await runRestartCommand(
      { mcp: true, injectMcp: true },
      {} as Command,
      fake.dependencies,
    );

    expect(fake.connectToDaemon).toHaveBeenCalledWith({
      host: "127.0.0.1:6767",
      timeout: 15_000,
    });
    expect(fake.restartServer).toHaveBeenCalledWith("cli_daemon_restart");
    expect(fake.close).toHaveBeenCalledOnce();
    expect(fake.stopLocalDaemon).not.toHaveBeenCalled();
    expect(fake.startLocalDaemonDetached).not.toHaveBeenCalled();
    expect(result.data).toMatchObject({
      action: "restart_requested",
      home: "/tmp/paseo",
      pid: "100",
    });
  });

  it("keeps the stop-start path for restarts issued outside a managed agent", async () => {
    const fake = makeDependencies();

    const result = await runRestartCommand({}, {} as Command, fake.dependencies);

    expect(fake.stopLocalDaemon).toHaveBeenCalledOnce();
    expect(fake.startLocalDaemonDetached).toHaveBeenCalledOnce();
    expect(fake.connectToDaemon).not.toHaveBeenCalled();
    expect(result.data).toMatchObject({ action: "restarted", pid: "200" });
  });

  it("keeps the stop-start path when a managed agent targets another daemon home", async () => {
    const fake = makeDependencies({
      env: { PASEO_AGENT_ID: "agent-1" },
      currentHome: "/tmp/owning-daemon",
      targetHome: "/tmp/other-daemon",
    });

    await runRestartCommand({ home: "/tmp/other-daemon" }, {} as Command, fake.dependencies);

    expect(fake.stopLocalDaemon).toHaveBeenCalledOnce();
    expect(fake.startLocalDaemonDetached).toHaveBeenCalledOnce();
    expect(fake.connectToDaemon).not.toHaveBeenCalled();
  });

  it("rejects launch-option changes that cannot survive an owning worker recycle", async () => {
    const fake = makeDependencies({ env: { PASEO_AGENT_ID: "agent-1" } });

    await expect(
      runRestartCommand({ port: "7000" }, {} as Command, fake.dependencies),
    ).rejects.toMatchObject({
      code: "INVALID_OPTIONS",
      message: "Cannot change daemon launch options from a Paseo-owned agent",
    });

    expect(fake.restartServer).not.toHaveBeenCalled();
    expect(fake.stopLocalDaemon).not.toHaveBeenCalled();
  });
});
