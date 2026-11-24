import { expect, test } from "vitest";
import { openCodeMajorVersion } from "./runtime-client.js";

test.each([
  ["1.14.46", 1],
  ["unexpected wrapper output", 1],
  ["", 1],
  ["opencode v2.0.10\n", 2],
  ["v2.0.10-beta.1", 2],
])("identifies the OpenCode runtime version %s", (output, major) => {
  expect(openCodeMajorVersion(String(output))).toBe(major);
});

test.each(["3.0.0", "2.0.9", "2.0.7", "2.0.4", "2.0.3", "v2.0.1"])(
  "rejects unsupported OpenCode version output %s",
  (output) => {
    expect(() => openCodeMajorVersion(output)).toThrow();
  },
);

test("retries a rejected version probe after the configured binary changes", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { OpenCodeRuntimeClient } = await import("./runtime-client.js");
  const { createTestLogger } = await import("../../../../test-utils/test-logger.js");
  const root = await mkdtemp(join(tmpdir(), "opencode-version-probe-"));
  const script = join(root, "version.cjs");
  const client = new OpenCodeRuntimeClient(createTestLogger(), {
    command: { mode: "replace", argv: [process.execPath, script] },
    env: { XDG_STATE_HOME: root },
  });
  try {
    await writeFile(script, 'console.log("opencode v2.0.3")');
    await expect(client.fetchCatalog({ scope: "global", force: true })).rejects.toThrow(
      "Update OpenCode to 2.0.10 or newer, then refresh the provider in Paseo",
    );
    await writeFile(script, 'console.log("opencode v3.0.0")');
    await expect(client.fetchCatalog({ scope: "global", force: true })).rejects.toThrow(
      "Unsupported OpenCode major version 3",
    );
  } finally {
    await client.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  ["console.log('wrapper output')", "unrecognized output"],
  ["process.exit(1)", "failed command"],
])("retries a %s version probe after updating to v2 (%s)", async (initialSource) => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { OpenCodeRuntimeClient } = await import("./runtime-client.js");
  const { createTestLogger } = await import("../../../../test-utils/test-logger.js");
  const root = await mkdtemp(join(tmpdir(), "opencode-version-retry-"));
  const script = join(root, "version.cjs");
  const client = new OpenCodeRuntimeClient(createTestLogger(), {
    command: { mode: "replace", argv: [process.execPath, script] },
    env: { XDG_STATE_HOME: root },
  });
  try {
    await writeFile(script, initialSource);
    expect(
      (await client.listControls({ provider: "opencode", cwd: root })).controls[0]?.label,
    ).toBe("Auto Accept");
    await writeFile(script, 'console.log("opencode v2.0.10")');
    expect(
      (await client.listControls({ provider: "opencode", cwd: root })).controls[0]?.label,
    ).toBe("Auto-accept");
  } finally {
    await client.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("re-probes a v1 runtime on a forced refresh after OpenCode is updated to v2", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { OpenCodeRuntimeClient } = await import("./runtime-client.js");
  const { createTestLogger } = await import("../../../../test-utils/test-logger.js");
  const root = await mkdtemp(join(tmpdir(), "opencode-version-upgrade-"));
  const script = join(root, "version.cjs");
  const client = new OpenCodeRuntimeClient(createTestLogger(), {
    command: { mode: "replace", argv: [process.execPath, script] },
    env: { XDG_STATE_HOME: root },
  });
  const controlLabel = async () =>
    (await client.listControls({ provider: "opencode", cwd: root })).controls[0]?.label;
  try {
    await writeFile(script, 'console.log("1.14.46")');
    expect(await controlLabel()).toBe("Auto Accept");
    await writeFile(script, 'console.log("opencode v2.0.10")');
    expect(await controlLabel()).toBe("Auto Accept");

    // The fake binary cannot serve, so the refresh fails on the v2 startup path it switched to.
    await expect(client.fetchCatalog({ scope: "global", force: true })).rejects.toThrow(
      "OpenCode v2 server exited during startup",
    );

    expect(await controlLabel()).toBe("Auto-accept");
  } finally {
    await client.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

async function createCountingVersionBinary(prefix: string) {
  const { mkdtemp, writeFile, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { OpenCodeRuntimeClient } = await import("./runtime-client.js");
  const { createTestLogger } = await import("../../../../test-utils/test-logger.js");
  const root = await mkdtemp(join(tmpdir(), prefix));
  const script = join(root, "version.cjs");
  const probes = join(root, "probes");
  await writeFile(probes, "");
  const client = new OpenCodeRuntimeClient(createTestLogger(), {
    command: { mode: "replace", argv: [process.execPath, script] },
    env: { XDG_STATE_HOME: root },
  });
  return {
    client,
    root,
    report: (version: string) =>
      writeFile(
        script,
        `if (process.argv.includes("--version")) require("node:fs").appendFileSync(${JSON.stringify(probes)}, "x"); console.log(${JSON.stringify(version)})`,
      ),
    probeCount: async () => (await readFile(probes, "utf8")).length,
    controlLabel: async () =>
      (await client.listControls({ provider: "opencode", cwd: root })).controls[0]?.label,
    dispose: async () => {
      await client.shutdown();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("keeps a v2 runtime on a forced refresh without probing the binary again", async () => {
  const binary = await createCountingVersionBinary("opencode-v2-refresh-");
  try {
    await binary.report("opencode v2.0.10");
    expect(await binary.controlLabel()).toBe("Auto-accept");
    expect(await binary.probeCount()).toBe(1);

    await expect(binary.client.fetchCatalog({ scope: "global", force: true })).rejects.toThrow(
      "OpenCode v2 server exited during startup",
    );

    expect(await binary.probeCount()).toBe(1);
    expect(await binary.controlLabel()).toBe("Auto-accept");
  } finally {
    await binary.dispose();
  }
});

test.each([0, 1, 2, 3, 4, 5, 6, 8])(
  "probes once when a second forced refresh starts %i microtasks after the first",
  async (ticks) => {
    const binary = await createCountingVersionBinary("opencode-concurrent-refresh-");
    try {
      await binary.report("1.14.46");
      expect(await binary.controlLabel()).toBe("Auto Accept");
      await binary.report("opencode v2.0.10");

      const first = binary.client.fetchCatalog({ scope: "global", force: true });
      for (let tick = 0; tick < ticks; tick++) await Promise.resolve();
      const second = binary.client.fetchCatalog({ scope: "global", force: true });
      const results = await Promise.allSettled([first, second]);

      expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
      expect(await binary.probeCount()).toBe(2);
      expect(await binary.controlLabel()).toBe("Auto-accept");
    } finally {
      await binary.dispose();
    }
  },
);

test.each([
  "process.exit(1)",
  'console.log("custom wrapper output")',
  "setTimeout(() => {}, 30000)",
])(
  "preserves legacy operations when the version probe is inconclusive: %s",
  async (source) => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { OpenCodeRuntimeClient } = await import("./runtime-client.js");
    const { OpenCodeAgentClient } = await import("../opencode-agent.js");
    const { createTestLogger } = await import("../../../../test-utils/test-logger.js");
    const { OpenCodeServerManager } = await import("./server-manager.js");
    const root = await mkdtemp(join(tmpdir(), "opencode-legacy-probe-"));
    const script = join(root, "version.cjs");
    await writeFile(script, source);
    const logger = createTestLogger();
    let legacyShutdown = false;
    class TrackedServerManager extends OpenCodeServerManager {
      override async shutdown() {
        legacyShutdown = true;
        await super.shutdown();
      }
    }
    const client = new OpenCodeRuntimeClient(
      logger,
      {
        command: { mode: "replace", argv: [process.execPath, script] },
        env: { XDG_STATE_HOME: root },
      },
      { serverManager: new TrackedServerManager({ logger }) },
    );
    const legacy = new OpenCodeAgentClient(logger);
    const config = { provider: "opencode", cwd: root };
    try {
      expect(await client.listControls(config)).toEqual(await legacy.listControls(config));
    } finally {
      await client.shutdown();
      await legacy.shutdown();
      await rm(root, { recursive: true, force: true });
    }
    expect(legacyShutdown).toBe(true);
  },
  10000,
);

test("selects v2 without probing the binary when an external server is configured", async () => {
  const { OpenCodeRuntimeClient } = await import("./runtime-client.js");
  const { createTestLogger } = await import("../../../../test-utils/test-logger.js");
  const client = new OpenCodeRuntimeClient(createTestLogger(), {
    command: { mode: "replace", argv: [process.execPath, "-e", "process.exit(1)"] },
    env: { PASEO_OPENCODE_SERVER_URL: "http://127.0.0.1:4096" },
  });
  try {
    const { controls } = await client.listControls({ provider: "opencode", cwd: "/tmp/project" });
    expect(controls.map((control) => control.label)).toEqual(["Auto-accept"]);
  } finally {
    await client.shutdown();
  }
});

test("keeps native Paseo tools available when an external server is configured", async () => {
  const { OpenCodeRuntimeClient } = await import("./runtime-client.js");
  const { createTestLogger } = await import("../../../../test-utils/test-logger.js");
  const { OpenCodeBridge } = await import("./bridge.js");
  const bridge = new OpenCodeBridge({ paseoHome: "/tmp", logger: createTestLogger() });
  const external = new OpenCodeRuntimeClient(
    createTestLogger(),
    { env: { PASEO_OPENCODE_SERVER_URL: "http://127.0.0.1:4096" } },
    { bridge },
  );
  const local = new OpenCodeRuntimeClient(createTestLogger(), undefined, { bridge });
  try {
    expect(external.capabilities.supportsNativePaseoTools).toBe(true);
    expect(local.capabilities.supportsNativePaseoTools).toBe(true);
  } finally {
    await external.shutdown();
    await local.shutdown();
  }
});
