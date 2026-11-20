import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { createTestLogger } from "../../../../../test-utils/test-logger.js";
import { OpenCodeBridge } from "../bridge.js";
import { provisionLocalBridge } from "./bridge-provisioning.js";
import { V2Runtime, type V2RuntimeStartup } from "./runtime.js";
import { V2Harness } from "../test-utils/v2-harness.js";
import type { ManagedProcessRegistry } from "../../../../managed-processes/managed-processes.js";
import type { OpenCodeServiceSelection } from "./service-selection.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("retained connection leases keep launch resources until each lease confirms release", async () => {
  const harness = new V2Harness();
  const runtime = new V2Runtime({
    logger: createTestLogger(),
    startup: {
      select: async () => ({ kind: "owned" }),
      start: async () => ({ ...harness.connection, stop: async () => undefined }),
    },
  });
  let users = 0;
  const retain = () => {
    users += 1;
    return async () => {
      users -= 1;
    };
  };
  try {
    const parent = await runtime.acquire({ dedicated: true });
    parent.retainPluginResources!(retain);
    const child = parent.retain({ dedicated: true });
    expect(users).toBe(2);
    await parent.release();
    expect(users).toBe(1);
    await child.release();
    expect(users).toBe(0);
  } finally {
    await runtime.shutdown();
  }
});

test("owned and discovered targets describe mutable restrictions without starting helpers", async () => {
  let starts = 0;
  const runtime = new V2Runtime({
    logger: createTestLogger(),
    selection: { kind: "discovered", server: { url: "http://127.0.0.1:1" } },
    startup: {
      select: async () => ({ kind: "owned" }),
      start: async () => {
        starts += 1;
        throw new Error("helper must not start");
      },
    },
  });
  try {
    expect(await runtime.describeRestrictions()).toEqual({
      mcpConfiguration: "mutable",
      processEnvironment: "mutable",
    });
    expect(starts).toBe(0);
  } finally {
    await runtime.shutdown();
  }
});

test("MCP location reservations are shared by leases and roll back only before configuration", async () => {
  const harness = new V2Harness();
  const runtime = new V2Runtime({
    logger: createTestLogger(),
    startup: {
      select: async () => ({ kind: "owned" }),
      start: async () => ({ ...harness.connection, stop: async () => undefined }),
    },
  });
  const first = await runtime.acquire({ dedicated: true });
  const second = first.retain({ dedicated: true });
  const firstServers = { tools: { type: "http" as const, url: "https://first.test" } };
  const otherServers = { tools: { type: "http" as const, url: "https://second.test" } };
  first.reserveMcpServers("/children", firstServers);
  second.reserveMcpServers("/children", firstServers);
  firstServers.tools.url = "https://mutated.test";
  expect(() => second.reserveMcpServers("/children", otherServers)).toThrow(
    "cannot change MCP servers",
  );
  await first.release();
  const third = second.retain({ dedicated: true });
  expect(() => third.reserveMcpServers("/children", otherServers)).toThrow(
    "cannot change MCP servers",
  );
  await second.release();
  third.reserveMcpServers("/children", otherServers);
  third.commitMcpServers("/children");
  const fourth = third.retain({ dedicated: true });
  await third.release();
  expect(() => fourth.reserveMcpServers("/children", {})).toThrow("cannot change MCP servers");
  fourth.reserveMcpServers("/elsewhere", {});
  fourth.commitMcpServers("/elsewhere");
  await fourth.release();
  await runtime.shutdown();
});

test("replacement generations do not inherit MCP registrations from exited helpers", async () => {
  const harness = new V2Harness();
  const exit = deferred<Error>();
  let starts = 0;
  const runtime = new V2Runtime({
    logger: createTestLogger(),
    startup: {
      select: async () => ({ kind: "owned" }),
      start: async () => {
        starts += 1;
        return {
          ...harness.connection,
          exited: starts === 1 ? exit.promise : harness.connection.exited,
          stop: async () => undefined,
        };
      },
    },
  });
  const first = await runtime.acquire();
  first.reserveMcpServers("/children", {});
  first.commitMcpServers("/children");
  exit.resolve(new Error("helper exited"));
  await first.exited;
  const next = await runtime.acquire();
  next.reserveMcpServers("/children", { tools: { type: "stdio", command: "tools" } });
  next.commitMcpServers("/children");
  expect(starts).toBe(2);
  await first.release();
  await next.release();
  await runtime.shutdown();
});

test("shutdown during selection prevents any helper startup", async () => {
  const selecting = deferred<OpenCodeServiceSelection>();
  let starts = 0;
  const runtime = new V2Runtime({
    logger: createTestLogger(),
    startup: {
      select: () => selecting.promise,
      start: async () => {
        starts += 1;
        throw new Error("unexpected startup");
      },
    },
  });
  const pending = runtime.acquire();
  const rejected = expect(pending).rejects.toThrow("runtime is closed");
  await runtime.shutdown();
  selecting.resolve({ kind: "owned" });
  await rejected;
  await expect(runtime.acquire()).rejects.toThrow("runtime is closed");
  expect(starts).toBe(0);
});

test("shutdown aborts readiness and cleans a helper that finishes after cancellation", async () => {
  const harness = new V2Harness();
  const started = deferred<AbortSignal>();
  const finish = deferred<void>();
  let stops = 0;
  const runtime = new V2Runtime({
    logger: createTestLogger(),
    startup: {
      select: async () => ({ kind: "owned" }),
      start: async ({ signal }) => {
        started.resolve(signal);
        await finish.promise;
        return {
          ...harness.connection,
          stop: async () => {
            stops += 1;
          },
        };
      },
    },
  });
  const pending = runtime.acquire();
  const rejected = expect(pending).rejects.toThrow("runtime is closed");
  const signal = await started.promise;
  const shutdown = runtime.shutdown();
  expect(signal.aborted).toBe(true);
  finish.resolve();
  await shutdown;
  await rejected;
  expect(stops).toBe(1);
});

test("canceling the last waiter aborts startup and a new caller gets an independent start", async () => {
  const first = new V2Harness();
  const second = new V2Harness();
  const started = deferred<AbortSignal>();
  const finish = deferred<void>();
  let starts = 0;
  let stops = 0;
  const runtime = new V2Runtime({
    logger: createTestLogger(),
    startup: {
      select: async () => ({ kind: "owned" }),
      start: async ({ signal }) => {
        starts += 1;
        if (starts === 1) {
          started.resolve(signal);
          await finish.promise;
          return {
            ...first.connection,
            stop: async () => {
              stops += 1;
            },
          };
        }
        return {
          ...second.connection,
          stop: async () => {
            stops += 1;
          },
        };
      },
    },
  });
  const abort = new AbortController();
  const pending = runtime.acquire({ signal: abort.signal });
  const rejected = expect(pending).rejects.toThrow("canceled");
  const signal = await started.promise;
  abort.abort(new Error("canceled"));
  await rejected;
  expect(signal.aborted).toBe(true);
  const survivor = await runtime.acquire();
  expect(survivor.client).toBe(second.api);
  finish.resolve();
  await survivor.release();
  await runtime.shutdown();
  expect(starts).toBe(2);
  expect(stops).toBe(2);
});

test("discovered default and two isolated generations have independent clients and cleanup", async () => {
  const shared = new V2Harness();
  const first = new V2Harness();
  const second = new V2Harness();
  const targets: string[] = [];
  const environments: Record<string, string>[] = [];
  const stopped: string[] = [];
  const runtime = new V2Runtime({
    logger: createTestLogger(),
    startup: {
      select: async () => ({ kind: "discovered", server: { url: "http://127.0.0.1:1" } }),
      start: async ({ selection, env }) => {
        targets.push(selection.kind);
        environments.push(env);
        const isolated = env.TOKEN === "first" ? first : second;
        const harness = selection.kind === "discovered" ? shared : isolated;
        return {
          ...harness.connection,
          stop: async () => {
            stopped.push(env.TOKEN ?? "disconnect shared");
          },
        };
      },
    },
  });
  const catalog = await runtime.acquire({ env: {} });
  const one = await runtime.acquire({ env: { TOKEN: "first" } });
  const two = await runtime.acquire({ dedicated: true, env: { TOKEN: "second" } });
  const refreshed = await runtime.acquire({ fresh: true });
  expect(targets).toEqual(["discovered", "owned", "owned"]);
  expect(environments).toEqual([{}, { TOKEN: "first" }, { TOKEN: "second" }]);
  expect(catalog.client).toBe(shared.api);
  expect(refreshed.client).toBe(shared.api);
  expect(one.client).toBe(first.api);
  expect(two.client).toBe(second.api);
  await one.release();
  expect(stopped).toEqual(["first"]);
  await two.release();
  expect(stopped).toEqual(["first", "second"]);
  await catalog.release();
  await refreshed.release();
  expect(stopped).toEqual(["first", "second"]);
  await runtime.shutdown();
  expect(stopped).toEqual(["first", "second", "disconnect shared"]);
});

test("provider process environment selects a reusable owned default despite discovery", async () => {
  const harness = new V2Harness();
  const targets: string[] = [];
  let stops = 0;
  const runtime = new V2Runtime({
    logger: createTestLogger(),
    settings: { env: { TOKEN: "provider" } },
    startup: {
      select: async () => ({ kind: "discovered", server: { url: "http://127.0.0.1:1" } }),
      start: async ({ selection }) => {
        targets.push(selection.kind);
        return {
          ...harness.connection,
          stop: async () => {
            stops += 1;
          },
        };
      },
    },
  });
  const first = await runtime.acquire();
  await first.release();
  const second = await runtime.acquire({ fresh: true, env: {} });
  expect(targets).toEqual(["owned"]);
  expect(second.client).toBe(first.client);
  await second.release();
  expect(stops).toBe(0);
  await runtime.shutdown();
  expect(stops).toBe(1);
});

test("discovered configuration and connection directory keys do not force an owned helper", async () => {
  const harness = new V2Harness();
  const targets: string[] = [];
  const runtime = new V2Runtime({
    logger: createTestLogger(),
    settings: {
      env: {
        XDG_CONFIG_HOME: "/scratch/config",
        XDG_STATE_HOME: "/scratch/state",
        OPENCODE_CONFIG_DIR: "/scratch/opencode",
        PASEO_OPENCODE_BRIDGE_URL: "http://127.0.0.1:1234",
        PASEO_OPENCODE_BRIDGE_PORT: "1234",
      },
    },
    startup: {
      select: async () => ({ kind: "discovered", server: { url: "http://127.0.0.1:1" } }),
      start: async ({ selection }) => {
        targets.push(selection.kind);
        return { ...harness.connection, stop: async () => undefined };
      },
    },
  });
  const connection = await runtime.acquire({ env: {} });
  expect(targets).toEqual(["discovered"]);
  await connection.release();
  await runtime.shutdown();
});

test("a real owned helper receives provider and per-session environment independently", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-opencode-env-"));
  const script = path.join(root, "server.cjs");
  await writeFile(
    script,
    `const http = require('node:http');
    require('node:fs').writeFileSync(process.env.RECORD, JSON.stringify({ PROVIDER: process.env.PROVIDER, TOKEN: process.env.TOKEN }));
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ version: '2.0.10', pid: process.pid, urls: [], paths: { tmp: '/tmp' } }));
    });
    server.listen(0, '127.0.0.1', () => console.log('server listening on http://127.0.0.1:' + server.address().port));`,
  );
  const runtime = new V2Runtime({
    logger: createTestLogger(),
    selection: { kind: "discovered", server: { url: "http://127.0.0.1:1" } },
    settings: {
      command: { mode: "replace", argv: [process.execPath, script] },
      env: { PROVIDER: "configured", RECORD: path.join(root, "default.json") },
    },
  });
  try {
    const catalog = await runtime.acquire();
    const first = await runtime.acquire({
      env: { TOKEN: "first", RECORD: path.join(root, "first.json") },
    });
    const second = await runtime.acquire({
      env: { TOKEN: "second", RECORD: path.join(root, "second.json") },
    });
    expect(JSON.parse(await readFile(path.join(root, "default.json"), "utf8"))).toEqual({
      PROVIDER: "configured",
    });
    expect(JSON.parse(await readFile(path.join(root, "first.json"), "utf8"))).toEqual({
      PROVIDER: "configured",
      TOKEN: "first",
    });
    expect(JSON.parse(await readFile(path.join(root, "second.json"), "utf8"))).toEqual({
      PROVIDER: "configured",
      TOKEN: "second",
    });
    const pid = (await catalog.client.server.info()).pid;
    expect((await first.client.server.info()).pid).not.toBe(pid);
    expect((await second.client.server.info()).pid).not.toBe(
      (await first.client.server.info()).pid,
    );
    await first.release();
    await expect(first.exited).resolves.toBeInstanceOf(Error);
    expect((await second.client.server.info()).version).toBe("2.0.10");
    await second.release();
    await expect(second.exited).resolves.toBeInstanceOf(Error);
    await catalog.release();
    const refreshed = await runtime.acquire({ fresh: true });
    expect((await refreshed.client.server.info()).pid).toBe(pid);
    await refreshed.release();
  } finally {
    await runtime.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("shutdown kills a real owned helper before it announces readiness", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-opencode-startup-"));
  const script = path.join(root, "waiting.cjs");
  await writeFile(script, "setInterval(() => {}, 1000);");
  const recorded = deferred<number>();
  const removed: string[] = [];
  const managedProcesses: ManagedProcessRegistry = {
    record: async (input) => {
      recorded.resolve(input.pid);
      return {
        ...input,
        id: "helper",
        metadata: {},
        identity: { commandLine: null, startedAt: null },
        createdAt: "2026-01-01T00:00:00.000Z",
      };
    },
    remove: async (id) => {
      removed.push(id);
    },
    list: async () => [],
    reapStale: async () => ({
      checked: 0,
      dead: 0,
      mismatched: 0,
      removed: 0,
      terminated: 0,
      errors: [],
    }),
  };
  const runtime = new V2Runtime({
    logger: createTestLogger(),
    managedProcesses,
    selection: { kind: "owned" },
    settings: { command: { mode: "replace", argv: [process.execPath, script] } },
  });
  const pending = runtime.acquire();
  const rejected = expect(pending).rejects.toThrow("runtime is closed");
  try {
    const pid = await recorded.promise;
    await runtime.shutdown();
    await rejected;
    expect(removed).toEqual(["helper"]);
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    await runtime.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("an incompatible owned helper is cleaned up without falling back to discovery", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-opencode-version-"));
  const script = path.join(root, "old.cjs");
  const record = path.join(root, "pid");
  await writeFile(
    script,
    `const http = require('node:http');
    require('node:fs').writeFileSync(${JSON.stringify(record)}, String(process.pid));
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ version: '2.0.9', pid: process.pid, urls: [], paths: { tmp: '/tmp' } }));
    });
    server.listen(0, '127.0.0.1', () => console.log('server listening on http://127.0.0.1:' + server.address().port));`,
  );
  const runtime = new V2Runtime({
    logger: createTestLogger(),
    selection: { kind: "discovered", server: { url: "http://127.0.0.1:1" } },
    settings: { command: { mode: "replace", argv: [process.execPath, script] } },
  });
  try {
    await expect(runtime.acquire({ dedicated: true })).rejects.toThrow(
      "Unsupported OpenCode version 2.0.9",
    );
    const pid = Number(await readFile(record, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    await runtime.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("retaining a default connection rejects new process isolation", async () => {
  const harness = new V2Harness();
  const runtime = new V2Runtime({
    logger: createTestLogger(),
    startup: {
      select: async () => ({ kind: "owned" }),
      start: async () => ({ ...harness.connection, stop: async () => undefined }),
    },
  });
  try {
    const connection = await runtime.acquire();
    expect(() => connection.retain({ dedicated: true })).toThrow("requires an isolated server");
    await connection.release();
  } finally {
    await runtime.shutdown();
  }
});

test("retaining an isolated connection rejects a changed or removed environment", async () => {
  const harness = new V2Harness();
  const runtime = new V2Runtime({
    logger: createTestLogger(),
    startup: {
      select: async () => ({ kind: "owned" }),
      start: async () => ({ ...harness.connection, stop: async () => undefined }),
    },
  });
  try {
    const connection = await runtime.acquire({ env: { TOKEN: "first" } });
    expect(() => connection.retain({ env: { TOKEN: "second" } })).toThrow(
      "cannot change process environment",
    );
    expect(() => connection.retain()).toThrow("cannot change process environment");
    const retained = connection.retain({ env: { TOKEN: "first" } });
    await retained.release();
    await connection.release();
  } finally {
    await runtime.shutdown();
  }
});

test("retained leases keep an isolated helper alive until the final idempotent release", async () => {
  const harness = new V2Harness();
  let stops = 0;
  const runtime = new V2Runtime({
    logger: createTestLogger(),
    startup: {
      select: async () => ({ kind: "owned" }),
      start: async () => ({
        ...harness.connection,
        stop: async () => {
          stops += 1;
        },
      }),
    },
  });
  const env = {
    TOKEN: "first",
    PASEO_AGENT_ID: "owner",
    PASEO_AGENT_CWD: "/owner",
    PASEO_WORKSPACE_ID: "owner",
  };
  const first = await runtime.acquire({ env });
  env.TOKEN = "mutated";
  const second = first.retain({
    env: {
      TOKEN: "first",
      PASEO_AGENT_ID: "child",
      PASEO_AGENT_CWD: "/child",
      PASEO_WORKSPACE_ID: "child",
    },
  });
  await first.release();
  await first.release();
  expect(stops).toBe(0);
  expect(() => first.retain()).toThrow("connection has been released");
  await second.release();
  expect(stops).toBe(1);
  await runtime.shutdown();
  expect(stops).toBe(1);
});

test("a failed startup does not poison later default acquisition", async () => {
  const harness = new V2Harness();
  let starts = 0;
  const runtime = new V2Runtime({
    logger: createTestLogger(),
    startup: {
      select: async () => ({ kind: "owned" }),
      start: async () => {
        starts += 1;
        if (starts === 1) throw new Error("startup failed");
        return { ...harness.connection, stop: async () => undefined };
      },
    },
  });
  await expect(runtime.acquire()).rejects.toThrow("startup failed");
  const next = await runtime.acquire();
  expect(next.client).toBe(harness.api);
  expect(starts).toBe(2);
  await next.release();
  await runtime.shutdown();
});

test("canceling one default waiter preserves the startup reserved by another", async () => {
  const harness = new V2Harness();
  const started = deferred<void>();
  const ready = deferred<void>();
  let starts = 0;
  let stops = 0;
  const startup: V2RuntimeStartup = {
    select: async () => ({ kind: "owned" }),
    start: async () => {
      starts += 1;
      started.resolve();
      await ready.promise;
      return {
        ...harness.connection,
        stop: async () => {
          stops += 1;
        },
      };
    },
  };
  const runtime = new V2Runtime({ logger: createTestLogger(), startup });
  const abort = new AbortController();
  const canceled = runtime.acquire({ signal: abort.signal });
  const survivor = runtime.acquire();
  await started.promise;
  abort.abort(new Error("catalog canceled"));
  await expect(canceled).rejects.toThrow("catalog canceled");
  const next = runtime.acquire();
  ready.resolve();
  try {
    const [first, second] = await Promise.all([survivor, next]);
    expect(starts).toBe(1);
    expect(first.client).toBe(second.client);
    expect(stops).toBe(0);
    await first.release();
    await second.release();
  } finally {
    await runtime.shutdown();
  }
  expect(stops).toBe(1);
});

test("a discovered service leaves custom MCP sessions on an owned helper", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-isolated-opencode-"));
  const script = path.join(root, "server.cjs");
  await writeFile(
    script,
    `const http = require('node:http');
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ version: '2.0.10', pid: process.pid, urls: [], paths: { tmp: '/tmp' } }));
    });
    server.listen(0, '127.0.0.1', () => console.log('server listening on http://127.0.0.1:' + server.address().port));`,
  );
  const runtime = new V2Runtime({
    logger: createTestLogger(),
    selection: { kind: "discovered", server: { url: "http://127.0.0.1:1" } },
    settings: { command: { mode: "replace", argv: [process.execPath, script] } },
  });
  try {
    const connection = await runtime.acquire({ dedicated: true });
    expect((await connection.client.server.info()).version).toBe("2.0.10");
    await connection.release();
    await expect(connection.exited).resolves.toBeInstanceOf(Error);
  } finally {
    await runtime.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("an owned helper uses an installed bridge once and survives catalog refresh", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-owned-opencode-"));
  const config = path.join(root, "config", "opencode");
  const script = path.join(root, "server.cjs");
  const record = path.join(root, "env.json");
  const bridge = new OpenCodeBridge({ paseoHome: root, logger: createTestLogger() });
  await bridge.start();
  const artifact = fileURLToPath(await bridge.materializeV2Plugin());
  await provisionLocalBridge({
    configDirectory: config,
    artifact: path.join(artifact, "server.js"),
  });
  await writeFile(
    script,
    `
    const http = require('node:http');
    require('node:fs').writeFileSync(${JSON.stringify(record)}, process.env.OPENCODE_CONFIG_CONTENT);
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ version: '2.0.10', pid: process.pid, urls: [], paths: { tmp: '/tmp' } }));
    });
    server.listen(0, '127.0.0.1', () => console.log('server listening on http://127.0.0.1:' + server.address().port));
  `,
  );
  const runtime = new V2Runtime({
    logger: createTestLogger(),
    bridge,
    selection: { kind: "owned" },
    settings: {
      command: { mode: "replace", argv: [process.execPath, script] },
      env: { XDG_CONFIG_HOME: path.join(root, "config"), OPENCODE_CONFIG_CONTENT: "{}" },
    },
  });
  try {
    const first = await runtime.acquire();
    const pid = (await first.client.server.info()).pid;
    expect(JSON.parse(await readFile(record, "utf8"))).toEqual({});
    await first.release();
    const refreshed = await runtime.acquire({ fresh: true });
    expect((await refreshed.client.server.info()).pid).toBe(pid);
    await refreshed.release();
  } finally {
    await runtime.shutdown();
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test("reports a bridge port change that has not been applied", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-opencode-port-"));
  const bridge = new OpenCodeBridge({ paseoHome: root, logger: createTestLogger() });
  await bridge.start();
  const actual = Number(new URL(bridge.sharedV2Connection().baseUrl).port);
  const runtime = new V2Runtime({
    logger: createTestLogger(),
    bridge,
    selection: { kind: "explicit", server: { url: "http://127.0.0.1:1" } },
    settings: { env: { PASEO_OPENCODE_BRIDGE_PORT: actual === 1 ? "2" : "1" } },
  });
  try {
    await expect(runtime.acquire()).rejects.toThrow("restart Paseo to apply the bridge port");
  } finally {
    await runtime.shutdown();
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});
