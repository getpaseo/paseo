import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const { shutdownServer, close, tryConnectToDaemon } = vi.hoisted(() => {
  const shutdownServerMock = vi.fn(async () => {});
  const closeMock = vi.fn(async () => {});
  const tryConnectToDaemonMock = vi.fn(async () => ({
    getLastServerInfoMessage: () => ({ serverId: "srv_unrelated_main_daemon" }),
    shutdownServer: shutdownServerMock,
    close: closeMock,
  }));
  return {
    shutdownServer: shutdownServerMock,
    close: closeMock,
    tryConnectToDaemon: tryConnectToDaemonMock,
  };
});

vi.mock("../../utils/client.js", () => ({ tryConnectToDaemon }));

import { stopLocalDaemon } from "./local-daemon.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.clearAllMocks();
});

describe("local daemon stop ownership", () => {
  test("an empty isolated PASEO_HOME cannot shut down an unrelated daemon on port 6767", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-stop-ownership-"));
    tempRoots.push(root);
    const paseoHome = path.join(root, ".paseo");
    await mkdir(paseoHome, { recursive: true });
    await writeFile(
      path.join(paseoHome, "config.json"),
      JSON.stringify({ version: 1, daemon: { listen: "127.0.0.1:6767" } }),
    );

    await expect(stopLocalDaemon({ home: paseoHome, timeoutMs: 50 })).resolves.toMatchObject({
      action: "not_running",
      usedLifecycleRpc: false,
      reason: "not_running",
    });

    expect(tryConnectToDaemon).toHaveBeenCalledWith({
      host: "127.0.0.1:6767",
      timeout: 50,
    });
    expect(shutdownServer).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
});
