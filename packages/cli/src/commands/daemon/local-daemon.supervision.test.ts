import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  spawnProcess: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawnSync: mocks.spawnSync,
  };
});

vi.mock("@getpaseo/server", async () => {
  const actual = await vi.importActual<typeof import("@getpaseo/server")>("@getpaseo/server");
  return {
    ...actual,
    loadConfig: () => ({ listen: "127.0.0.1:6767" }),
    resolvePaseoHome: (env: NodeJS.ProcessEnv) => env.PASEO_HOME ?? "/tmp/paseo",
    spawnProcess: mocks.spawnProcess,
  };
});

class FakeChildProcess extends EventEmitter {
  pid = 4242;
  unref = vi.fn();
}

function expectSupervisorLaunch(argv: string[]): void {
  const joined = argv.join(" ");
  expect(joined).toContain("supervisor-entrypoint");
  expect(joined).not.toContain("src/server/index.ts");
  expect(joined).not.toContain("dist/server/server/index.js");
  expect(joined).not.toContain("src/server/daemon-worker.ts");
  expect(joined).not.toContain("dist/server/server/daemon-worker.js");
}

describe("local daemon launch supervision", () => {
  beforeEach(() => {
    vi.useRealTimers();
    mocks.spawnSync.mockReset();
    mocks.spawnProcess.mockReset();
  });

  test("foreground start spawns supervisor-entrypoint instead of server/index", async () => {
    mocks.spawnSync.mockReturnValue({ status: 0, error: undefined });

    const { startLocalDaemonForeground } = await import("./local-daemon.js");
    const status = startLocalDaemonForeground({ home: "/tmp/paseo-test", relay: false });

    expect(status).toBe(0);
    expect(mocks.spawnSync).toHaveBeenCalledOnce();
    const [command, argv] = mocks.spawnSync.mock.calls[0] as [string, string[]];
    expect(command).toBe(process.execPath);
    expectSupervisorLaunch(argv);
    expect(argv).toContain("--no-relay");
  });

  test("detached start spawns supervisor-entrypoint instead of server/index", async () => {
    vi.useFakeTimers();
    const child = new FakeChildProcess();
    mocks.spawnProcess.mockReturnValue(child);

    const { startLocalDaemonDetached } = await import("./local-daemon.js");
    const resultPromise = startLocalDaemonDetached({ home: "/tmp/paseo-test", mcp: false });
    await vi.advanceTimersByTimeAsync(1200);
    const result = await resultPromise;

    expect(result).toEqual({ pid: 4242, logPath: "/tmp/paseo-test/daemon.log" });
    expect(child.unref).toHaveBeenCalledOnce();
    expect(mocks.spawnProcess).toHaveBeenCalledOnce();
    const [command, argv] = mocks.spawnProcess.mock.calls[0] as [string, string[]];
    expect(command).toBe(process.execPath);
    expectSupervisorLaunch(argv);
    expect(argv).toContain("--no-mcp");
  });

  test("relay TLS flag is passed to the supervised daemon", async () => {
    mocks.spawnSync.mockReturnValue({ status: 0, error: undefined });

    const { startLocalDaemonForeground } = await import("./local-daemon.js");
    const status = startLocalDaemonForeground({
      home: "/tmp/paseo-test",
      relayUseTls: true,
    });

    expect(status).toBe(0);
    const [, argv, options] = mocks.spawnSync.mock.calls[0] as [
      string,
      string[],
      { env?: NodeJS.ProcessEnv },
    ];
    expect(argv).toContain("--relay-use-tls");
    expect(options.env?.PASEO_RELAY_USE_TLS).toBe("true");
  });
});
