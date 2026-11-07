import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import pino, { type Logger } from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

import { findExecutable } from "../../../executable-resolution/executable-resolution.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import type {
  ManagedProcessRecord,
  ManagedProcessRecordInput,
  ManagedProcessRegistry,
  ManagedProcessReapResult,
} from "../../managed-processes/managed-processes.js";
import type { ProcessTerminator, TreeKillTarget } from "../../../utils/tree-kill.js";
import {
  OpenCodeServerManager,
  type OpenCodeCommandPrefixResolver,
  type OpenCodePortAllocator,
  type OpenCodeServerProcessSpawner,
} from "./opencode/server-manager.js";
import type {
  OpenCodeEventConsumerFactory,
  OpenCodeEventSourceHandle,
} from "./opencode/event-consumer.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("OpenCodeServerManager generations", () => {
  test("logs generation lifecycle transitions", async () => {
    const { logger, records } = createCapturingLogger();
    const { manager } = createTestManager([4081, 4082], { logger });

    const first = await manager.acquireCurrent();
    const second = await manager.acquireNew();
    await second.release();
    await first.release();
    await manager.shutdown();

    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ msg: "OpenCode server generation started", port: 4081 }),
        expect.objectContaining({ msg: "OpenCode server generation retired", port: 4081 }),
        expect.objectContaining({ msg: "OpenCode server generation started", port: 4082 }),
        expect.objectContaining({ msg: "OpenCode server generation released", port: 4082 }),
        expect.objectContaining({ msg: "OpenCode server generation exited", port: 4081 }),
      ]),
    );
  });
  test("invalidates an unresponsive generation and starts a replacement", async () => {
    const sources: FakeEventSource[] = [];
    const { manager, runtime } = createTestManager([4_501, 4_502], {
      createEventSource: (input) => {
        const source = new FakeEventSource(input.onSustainedFailure);
        sources.push(source);
        return source;
      },
    });

    const first = await manager.acquireCurrent();
    expect(first.server.port).toBe(4_501);
    await sources[0]?.trigger(new Error("event stream stalled"));
    expect(manager.acquireExisting("http://127.0.0.1:4501")).toBeNull();
    await vi.waitFor(() => expect(runtime.terminatedPorts).toContain(4_501));
    expect(sources[0]?.terminalPublished).toBe(true);
    expect(sources[0]?.timeline.slice(0, 2)).toEqual(["terminal", "close-after-terminal"]);

    const replacement = await manager.acquireCurrent();
    expect(replacement.server.port).toBe(4_502);

    await replacement.release();
    await first.release();
    await manager.shutdown();
  });

  test("release waits for termination of an unresponsive shared generation", async () => {
    const sources: FakeEventSource[] = [];
    let finishTermination!: () => void;
    const terminationGate = new Promise<void>((resolve) => {
      finishTermination = resolve;
    });
    const { manager } = createTestManager([4_541], {
      terminateProcess: async (serverProcess) => {
        await terminationGate;
        (serverProcess as unknown as { exitBySignal(signal: NodeJS.Signals): void }).exitBySignal(
          "SIGTERM",
        );
        return "terminated";
      },
      createEventSource: (input) => {
        const source = new FakeEventSource(input.onSustainedFailure);
        sources.push(source);
        return source;
      },
    });

    const first = await manager.acquireCurrent();
    const second = await manager.acquireCurrent();
    await sources[0]?.trigger(new Error("event stream stalled"));

    let released = false;
    const releasing = (async () => {
      await first.release();
      released = true;
    })();
    await new Promise((resolve) => setImmediate(resolve));
    expect(released).toBe(false);

    finishTermination();
    await releasing;
    expect(released).toBe(true);

    await second.release();
    await manager.shutdown();
  });

  test("fails closed when termination cannot establish child exit", async () => {
    const sources: FakeEventSource[] = [];
    const terminated: number[] = [];
    const { manager, runtime } = createTestManager([4_551], {
      terminateProcess: async (serverProcess) => {
        terminated.push((serverProcess as unknown as { pid: number }).pid);
        return "kill-timeout";
      },
      createEventSource: (input) => {
        const source = new FakeEventSource(input.onSustainedFailure);
        sources.push(source);
        return source;
      },
    });

    const acquisition = await manager.acquireCurrent();
    await sources[0]?.trigger(new Error("event stream stalled"));
    await vi.waitFor(() => expect(terminated).toHaveLength(1));
    await expect(acquisition.release()).rejects.toThrow("did not report exit");
    expect(await runtime.managedProcesses.list()).toHaveLength(1);

    await expect(manager.shutdown()).rejects.toThrow("did not report exit");
  });

  test("invalidates a retired generation without touching its replacement", async () => {
    const sources: FakeEventSource[] = [];
    const { manager, runtime } = createTestManager([4_521, 4_522], {
      createEventSource: (input) => {
        const source = new FakeEventSource(input.onSustainedFailure);
        sources.push(source);
        return source;
      },
    });

    const old = await manager.acquireCurrent();
    const current = await manager.acquireNew();
    await sources[0]?.trigger(new Error("late failure"));
    await vi.waitFor(() => expect(runtime.terminatedPorts).toContain(4_521));
    expect(runtime.terminatedPorts).not.toContain(4_522);
    expect(manager.acquireExisting("http://127.0.0.1:4521")).toBeNull();
    const next = await manager.acquireCurrent();
    expect(next.server.port).toBe(4_522);

    await next.release();
    await current.release();
    await old.release();
    await manager.shutdown();
  });

  test("a later child exit unblocks a release that timed out", async () => {
    const { manager, runtime } = createTestManager([4_561], {
      terminateProcess: async () => "kill-timeout",
    });

    const acquisition = await manager.acquireCurrent();
    await expect(acquisition.release()).rejects.toThrow("did not report exit");
    expect(await runtime.managedProcesses.list()).toHaveLength(1);

    runtime.processForPort(4_561).exitNormally();

    await acquisition.release();
    await manager.shutdown();
    expect(await runtime.managedProcesses.list()).toHaveLength(0);
  });

  test("shutdown keeps a kill-timeout generation unavailable for acquisition", async () => {
    const { manager } = createTestManager([4_581], {
      terminateProcess: async () => "kill-timeout",
    });

    const acquisition = await manager.acquireCurrent();
    await expect(manager.shutdown()).rejects.toThrow("did not report exit");
    expect(manager.acquireExisting("http://127.0.0.1:4581")).toBeNull();
    await expect(manager.acquireCurrent()).rejects.toThrow("terminating");

    await acquisition.release().catch(() => undefined);
  });

  test("does not reacquire a dedicated generation while it is terminating", async () => {
    let finishTermination!: () => void;
    const terminationGate = new Promise<void>((resolve) => {
      finishTermination = resolve;
    });
    const { manager } = createTestManager([4_571], {
      terminateProcess: async (serverProcess) => {
        await terminationGate;
        (serverProcess as unknown as { exitBySignal(signal: NodeJS.Signals): void }).exitBySignal(
          "SIGTERM",
        );
        return "terminated";
      },
    });

    const dedicated = await manager.acquireDedicated({ PASEO_TEST: "1" });
    const releasing = dedicated.release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(manager.acquireExisting("http://127.0.0.1:4571")).toBeNull();

    finishTermination();
    await releasing;
    await manager.shutdown();
  });

  test("invalidates an unresponsive dedicated generation", async () => {
    const sources: FakeEventSource[] = [];
    const { manager, runtime } = createTestManager([4_531], {
      createEventSource: (input) => {
        const source = new FakeEventSource(input.onSustainedFailure);
        sources.push(source);
        return source;
      },
    });

    const dedicated = await manager.acquireDedicated({ PASEO_TEST: "1" });
    expect(dedicated.server.port).toBe(4_531);
    await sources[0]?.trigger(new Error("event stream stalled"));
    expect(manager.acquireExisting("http://127.0.0.1:4531")).toBeNull();
    await vi.waitFor(() => expect(runtime.terminatedPorts).toContain(4_531));

    await dedicated.release();
    await manager.shutdown();
  });

  test("shares one real SDK event stream across acquisitions until generation shutdown", async () => {
    const responses: ServerResponse[] = [];
    let requestCount = 0;
    const upstream = createServer((_request, response) => {
      requestCount += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.flushHeaders();
      responses.push(response);
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("Missing upstream address");
    const { manager } = createTestManager([address.port]);

    const first = await manager.acquireCurrent();
    const second = await manager.acquireCurrent();
    expect(first.events).toBe(second.events);
    await vi.waitFor(() => expect(responses).toHaveLength(1));
    responses[0]?.write(
      `data: ${JSON.stringify({ directory: "/workspace", payload: { type: "server.connected", properties: {} } })}\n\n`,
    );
    await first.events.ready();
    expect(requestCount).toBe(1);

    await first.release();
    expect(requestCount).toBe(1);
    await second.release();
    expect(requestCount).toBe(1);
    await manager.shutdown();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  test("uses an explicit base environment for the server process", async () => {
    const baseEnv = { HOME: "/isolated/home", PATH: "/isolated/bin" };
    const { manager, runtime } = createTestManager([4091], { baseEnv });

    const acquisition = await manager.acquireCurrent();

    expect(runtime.spawnCalls[0]?.options.baseEnv).toEqual(baseEnv);
    expect(acquisition.environment).toBe(runtime.spawnCalls[0]?.options.baseEnv);
    await acquisition.release();
  });

  test("rotation creates a new current server without killing a referenced old server", async () => {
    const { manager, runtime } = createTestManager([4101, 4102]);

    const oldAcquisition = await manager.acquireCurrent();
    const newAcquisition = await manager.acquireNew();

    expect(oldAcquisition.server.url).toBe("http://127.0.0.1:4101");
    expect(newAcquisition.server.url).toBe("http://127.0.0.1:4102");
    expect(runtime.terminatedPorts).toEqual([]);

    await newAcquisition.release();
    await oldAcquisition.release();

    expect(runtime.terminatedPorts).toEqual([4102, 4101]);
  });

  test("new acquisitions after rotation use the new server", async () => {
    const { manager, runtime } = createTestManager([4201, 4202]);

    const oldAcquisition = await manager.acquireCurrent();
    const rotatedAcquisition = await manager.acquireNew();
    const nextAcquisition = await manager.acquireCurrent();

    expect(nextAcquisition.server.url).toBe("http://127.0.0.1:4202");
    expect(runtime.terminatedPorts).toEqual([]);

    await rotatedAcquisition.release();
    expect(runtime.terminatedPorts).toEqual([]);
    await nextAcquisition.release();
    await oldAcquisition.release();
  });

  test("concurrent new-server acquisitions share one fresh generation", async () => {
    const { manager, runtime } = createTestManager([4251, 4252, 4253]);

    const initialAcquisition = await manager.acquireCurrent();
    await initialAcquisition.release();

    const [modelsAcquisition, modesAcquisition] = await Promise.all([
      manager.acquireNew(),
      manager.acquireNew(),
    ]);

    expect(modelsAcquisition.server.url).toBe("http://127.0.0.1:4252");
    expect(modesAcquisition.server.url).toBe("http://127.0.0.1:4252");
    expect(runtime.launchedPorts).toEqual([4251, 4252]);

    await modesAcquisition.release();
    await modelsAcquisition.release();
  });

  test("release is idempotent", async () => {
    const { manager, runtime } = createTestManager([4301, 4302]);

    const oldAcquisition = await manager.acquireCurrent();
    const newAcquisition = await manager.acquireNew();
    await newAcquisition.release();

    await oldAcquisition.release();
    await oldAcquisition.release();

    expect(runtime.terminatedPorts).toEqual([4302, 4301]);
  });

  test("shutdown kills current and retired servers", async () => {
    const { manager, runtime } = createTestManager([4401, 4402]);

    await manager.acquireCurrent();
    await manager.acquireNew();

    await manager.shutdown();

    expect(runtime.terminatedPorts).toEqual([4402, 4401]);
  });

  test("shutdown still signals a process after an earlier kill signal if it has not exited", async () => {
    const { manager, runtime } = createTestManager([4451]);

    await manager.acquireCurrent();
    runtime.processForPort(4451).markKillSignalSent();

    await manager.shutdown();

    expect(runtime.terminatedPorts).toEqual([4451]);
  });

  test("startup timeout kills the spawned server and removes its managed-process record", async () => {
    vi.useFakeTimers();
    const { manager, runtime } = createTestManager([4471], { autoAnnounce: false });

    const acquisition = manager.acquireCurrent();
    const failure = expect(acquisition).rejects.toThrow("OpenCode server startup timeout");
    await runtime.settle();

    await vi.advanceTimersByTimeAsync(30_000);

    await failure;
    expect(runtime.terminatedPorts).toEqual([4471]);
    expect(await runtime.managedProcesses.list()).toEqual([]);
  });

  test("aborted acquisition transfers no reference and leaves startup reusable", async () => {
    const { manager, runtime } = createTestManager([4477], { autoAnnounce: false });
    const controller = new AbortController();

    const abortedAcquisition = manager.acquireCurrent(controller.signal);
    await runtime.settle();
    controller.abort(new Error("catalog refresh expired"));

    await expect(abortedAcquisition).rejects.toThrow("catalog refresh expired");
    runtime.processForPort(4477).announceListening();

    const nextAcquisition = await manager.acquireCurrent();
    expect(nextAcquisition.server.url).toBe("http://127.0.0.1:4477");
    expect(runtime.launchedPorts).toEqual([4477]);

    await nextAcquisition.release();
    expect(runtime.terminatedPorts).toEqual([4477]);
  });

  test("shutdown kills a server that is still starting", async () => {
    const { manager, runtime } = createTestManager([4472], { autoAnnounce: false });

    const acquisition = manager.acquireCurrent();
    await runtime.settle();

    await manager.shutdown();

    await expect(acquisition).rejects.toThrow("OpenCode server exited with code null");
    expect(runtime.terminatedPorts).toEqual([4472]);
    expect(await runtime.managedProcesses.list()).toEqual([]);
  });

  test("dedicated server startup is protected from retired cleanup", async () => {
    const { manager, runtime } = createTestManager([4473, 4474], { autoAnnounce: false });

    const currentStart = manager.acquireCurrent();
    await runtime.settle();
    runtime.processForPort(4473).announceListening();
    const currentAcquisition = await currentStart;

    const dedicatedStart = manager.acquireDedicated({ TEST_ENV: "custom" });
    await runtime.settle();

    await currentAcquisition.release();
    expect(runtime.terminatedPorts).toEqual([4473]);

    runtime.processForPort(4474).announceListening();
    const dedicatedAcquisition = await dedicatedStart;

    expect(dedicatedAcquisition.server.url).toBe("http://127.0.0.1:4474");

    await dedicatedAcquisition.release();
    expect(runtime.terminatedPorts).toEqual([4473, 4474]);
  });

  test("acquireExisting keeps a retired dedicated server alive until every reference releases", async () => {
    const { manager, runtime } = createTestManager([4475]);

    const dedicatedAcquisition = await manager.acquireDedicated({ PASEO_AGENT_ID: "parent" });
    const existingAcquisition = manager.acquireExisting(dedicatedAcquisition.server.url);

    expect(existingAcquisition?.server.url).toBe("http://127.0.0.1:4475");

    await dedicatedAcquisition.release();
    expect(runtime.terminatedPorts).toEqual([]);

    await existingAcquisition?.release();
    expect(runtime.terminatedPorts).toEqual([4475]);
  });

  test("acquireExisting returns null for unknown or dead server urls", async () => {
    const { manager, runtime } = createTestManager([4476]);

    const acquisition = await manager.acquireDedicated({ PASEO_AGENT_ID: "parent" });
    const url = acquisition.server.url;

    expect(manager.acquireExisting("http://127.0.0.1:9999")).toBe(null);

    await acquisition.release();
    expect(runtime.terminatedPorts).toEqual([4476]);
    expect(manager.acquireExisting(url)).toBe(null);
  });

  test("repeated rotations leave zero unreferenced retired servers", async () => {
    const { manager, runtime } = createTestManager([4501, 4502, 4503]);

    const firstAcquisition = await manager.acquireCurrent();
    const secondAcquisition = await manager.acquireNew();
    await secondAcquisition.release();
    const thirdAcquisition = await manager.acquireNew();
    await thirdAcquisition.release();
    await firstAcquisition.release();

    expect(runtime.terminatedPorts).toEqual([4502, 4503, 4501]);
  });

  test("final release detaches the terminating generation before a concurrent acquire", async () => {
    const { manager, runtime } = createTestManager([4551, 4552]);

    const first = await manager.acquireCurrent();
    const release = first.release();
    const next = await manager.acquireCurrent();

    await release;
    expect(next.server.url).toBe("http://127.0.0.1:4552");
    expect(runtime.terminatedPorts).toEqual([4551]);

    await next.release();
  });
});

describe("OpenCodeServerManager managed process ledger", () => {
  test("records helper server starts and removes the record on process exit", async () => {
    const { manager, runtime } = createTestManager([4601]);

    await manager.acquireCurrent();

    expect(await runtime.managedProcesses.list()).toEqual([
      {
        id: "managed-process-1",
        owner: { provider: "opencode", kind: "helper-server" },
        pid: 14601,
        command: "opencode",
        args: ["serve", "--port", "4601"],
        metadata: { port: 4601 },
        identity: { commandLine: null, startedAt: null },
        createdAt: "test-created-at",
      },
    ]);

    runtime.processForPort(4601).exitNormally();
    await runtime.settle();

    expect(await runtime.managedProcesses.list()).toEqual([]);
  });

  test("removes helper server records on shutdown", async () => {
    const { manager, runtime } = createTestManager([4602]);

    await manager.acquireCurrent();

    await manager.shutdown();

    expect(runtime.terminatedPorts).toEqual([4602]);
    expect(await runtime.managedProcesses.list()).toEqual([]);
  });

  test("starts helper server from opencode-home", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "opencode-server-home-"));
    const opencodeHomeDir = path.join(tempDir, "opencode-home");
    try {
      const { manager, runtime } = createTestManager([4603], { opencodeHomeDir });

      const acquisition = await manager.acquireCurrent();

      expect(runtime.spawnCalls).toEqual([
        expect.objectContaining({
          command: "opencode",
          args: ["serve", "--port", "4603"],
          options: expect.objectContaining({ cwd: opencodeHomeDir }),
        }),
      ]);

      await acquisition.release();
      await manager.shutdown();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe.runIf(process.platform === "win32")(
  "OpenCodeServerManager Windows OpenCode npm install",
  () => {
    test("resolves the Windows npm shim to its native helper executable", async () => {
      const detectedOpenCode = await findExecutable("opencode");
      expect(detectedOpenCode, "Windows CI must install opencode-ai before server tests").not.toBe(
        null,
      );
      expect(path.extname(detectedOpenCode!).toLowerCase()).toBe(".cmd");

      const tempDir = mkdtempSync(path.join(os.tmpdir(), "opencode-real-windows-"));
      const opencodeHomeDir = path.join(tempDir, "opencode-home");
      const runtime = new FakeOpenCodeServerRuntime([4604], { autoAnnounce: true });
      const manager = new OpenCodeServerManager({
        logger: createTestLogger(),
        managedProcesses: runtime.managedProcesses,
        resolveHomeDir: () => opencodeHomeDir,
        portAllocator: runtime.allocatePort,
        spawnServerProcess: runtime.spawnServerProcess,
        terminateProcess: runtime.terminateProcess,
      });

      try {
        // Resolve the actual npm installation. Generation lifecycle coverage above
        // owns process readiness; this regression owns the Windows launch command.
        const acquisition = await manager.acquireCurrent();
        const records = await runtime.managedProcesses.list();
        expect(records).toHaveLength(1);
        const record = records[0]!;
        expect(path.extname(record.command).toLowerCase()).toBe(".exe");
        expect(path.normalize(record.command).toLowerCase()).toMatch(
          /opencode-(?:ai|windows-(?:x64|arm64))[\\/]bin[\\/]opencode\.exe$/,
        );
        expect(record.command.toLowerCase()).not.toBe(detectedOpenCode!.toLowerCase());
        expect(record.args).toEqual(["serve", "--port", String(acquisition.server.port)]);
        await acquisition.release();
      } finally {
        await manager.shutdown();
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  },
);

class FakeEventSource implements OpenCodeEventSourceHandle {
  private readonly listeners = new Set<Parameters<OpenCodeEventSourceHandle["subscribe"]>[0]>();
  readonly timeline: string[] = [];
  terminalPublished = false;

  constructor(
    private readonly onSustainedFailure: ((error: Error) => void | Promise<void>) | undefined,
  ) {}

  ready(): Promise<void> {
    return Promise.resolve();
  }

  subscribe(listener: Parameters<OpenCodeEventSourceHandle["subscribe"]>[0]): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  diagnostics() {
    return { attempt: 0, phase: "first-record" as const, elapsedMs: 0 };
  }

  async close(): Promise<void> {
    this.timeline.push(this.terminalPublished ? "close-after-terminal" : "close-before-terminal");
    this.listeners.clear();
  }

  async trigger(error: Error): Promise<void> {
    await this.onSustainedFailure?.(error);
    this.terminalPublished = true;
    this.timeline.push("terminal");
    for (const listener of this.listeners) {
      listener({ type: "server-exited", error });
    }
  }
}

function createTestManager(
  ports: number[],
  options: {
    autoAnnounce?: boolean;
    baseEnv?: Record<string, string>;
    opencodeHomeDir?: string;
    logger?: Logger;
    createEventSource?: OpenCodeEventConsumerFactory;
    terminateProcess?: ProcessTerminator;
  } = {},
): {
  manager: OpenCodeServerManager;
  runtime: FakeOpenCodeServerRuntime;
} {
  const { opencodeHomeDir } = options;
  const runtime = new FakeOpenCodeServerRuntime(ports, {
    autoAnnounce: options.autoAnnounce ?? true,
  });
  return {
    manager: new OpenCodeServerManager({
      logger: options.logger ?? createTestLogger(),
      baseEnv: options.baseEnv,
      managedProcesses: runtime.managedProcesses,
      portAllocator: runtime.allocatePort,
      resolveCommandPrefix: runtime.resolveCommandPrefix,
      ...(opencodeHomeDir ? { resolveHomeDir: () => opencodeHomeDir } : {}),
      spawnServerProcess: runtime.spawnServerProcess,
      terminateProcess: options.terminateProcess ?? runtime.terminateProcess,
      ...(options.createEventSource ? { createEventSource: options.createEventSource } : {}),
    }),
    runtime,
  };
}

function createCapturingLogger(): { logger: Logger; records: Array<Record<string, unknown>> } {
  const records: Array<Record<string, unknown>> = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      records.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      callback();
    },
  });
  return { logger: pino({ level: "info" }, stream), records };
}

class FakeOpenCodeServerRuntime {
  readonly managedProcesses = new FakeManagedProcesses();
  readonly terminatedPorts: number[] = [];
  readonly spawnCalls: Array<{
    command: string;
    args: string[];
    options: Parameters<OpenCodeServerProcessSpawner>[2];
  }> = [];
  private readonly ports: number[];
  private readonly autoAnnounce: boolean;
  private readonly processesByChild = new Map<ChildProcess, FakeOpenCodeProcess>();
  private readonly processesByPort = new Map<number, FakeOpenCodeProcess>();

  constructor(ports: number[], options: { autoAnnounce: boolean }) {
    this.ports = [...ports];
    this.autoAnnounce = options.autoAnnounce;
  }

  get launchedPorts(): number[] {
    return Array.from(this.processesByPort.keys());
  }

  readonly allocatePort: OpenCodePortAllocator = async () => {
    const port = this.ports.shift();
    if (!port) {
      throw new Error("No fake OpenCode port available");
    }
    return port;
  };

  readonly resolveCommandPrefix: OpenCodeCommandPrefixResolver = async () => ({
    command: "opencode",
    args: [],
  });

  readonly spawnServerProcess: OpenCodeServerProcessSpawner = (command, args, options) => {
    this.spawnCalls.push({ command, args, options });
    const port = Number(args.at(-1));
    const process = new FakeOpenCodeProcess({ port, pid: 10_000 + port });
    this.processesByChild.set(process.child, process);
    this.processesByPort.set(port, process);
    if (this.autoAnnounce) {
      queueMicrotask(() => process.announceListening());
    }
    return process.child;
  };

  readonly terminateProcess: ProcessTerminator = async (target: TreeKillTarget) => {
    const process = this.processForChild(target as ChildProcess);
    this.terminatedPorts.push(process.port);
    process.exitBySignal("SIGTERM");
    return "terminated";
  };

  processForPort(port: number): FakeOpenCodeProcess {
    const process = this.processesByPort.get(port);
    if (!process) {
      throw new Error(`No fake OpenCode process for port ${port}`);
    }
    return process;
  }

  async settle(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  private processForChild(child: ChildProcess): FakeOpenCodeProcess {
    const process = this.processesByChild.get(child);
    if (!process) {
      throw new Error("Unknown fake OpenCode process");
    }
    return process;
  }
}

class FakeOpenCodeProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly child: ChildProcess;
  readonly port: number;
  readonly pid: number;
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor(options: { port: number; pid: number }) {
    super();
    this.port = options.port;
    this.pid = options.pid;
    this.child = this as unknown as ChildProcess;
  }

  announceListening(): void {
    this.stdout.emit("data", Buffer.from("listening on"));
  }

  exitNormally(): void {
    this.exitCode = 0;
    this.emit("exit", 0, null);
  }

  exitBySignal(signal: NodeJS.Signals): void {
    this.killed = true;
    this.signalCode = signal;
    this.emit("exit", null, signal);
  }

  markKillSignalSent(): void {
    this.killed = true;
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.exitBySignal(signal ?? "SIGTERM");
    return true;
  }
}

class FakeManagedProcesses implements ManagedProcessRegistry {
  private records: ManagedProcessRecord[] = [];

  async record(input: ManagedProcessRecordInput): Promise<ManagedProcessRecord> {
    const record: ManagedProcessRecord = {
      id: `managed-process-${this.records.length + 1}`,
      ...input,
      metadata: input.metadata ?? {},
      identity: { commandLine: null, startedAt: null },
      createdAt: "test-created-at",
    };
    this.records.push(record);
    return record;
  }

  async remove(id: string): Promise<void> {
    this.records = this.records.filter((record) => record.id !== id);
  }

  async list(): Promise<ManagedProcessRecord[]> {
    return this.records;
  }

  async reapStale(): Promise<ManagedProcessReapResult> {
    return {
      checked: 0,
      dead: 0,
      mismatched: 0,
      removed: 0,
      terminated: 0,
      errors: [],
    };
  }
}
