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

test("records the runtime once and retains its position across resume", async () => {
  const { withOpenCodeRuntimeNotice } = await import("./runtime-notice.js");
  const { V2Harness } = await import("./test-utils/v2-harness.js");
  const { OpenCodeV2AgentClient } = await import("./v2/agent.js");
  const { createTestLogger } = await import("../../../../test-utils/test-logger.js");
  const harness = new V2Harness();
  const client = new OpenCodeV2AgentClient({
    logger: createTestLogger(),
    runtime: harness.runtime,
  });
  const original = withOpenCodeRuntimeNotice(
    await client.createSession({ provider: "opencode", cwd: "/tmp/project" }),
    2,
  );
  const notice = { type: "notification", level: "info", message: "This chat uses OpenCode v2." };
  try {
    expect(original.initialTimeline?.map((entry) => entry.item)).toEqual([notice]);
    const handle = original.describePersistence()!;
    await original.close();
    const resumed = withOpenCodeRuntimeNotice(await client.resumeSession(handle), 2, handle);
    try {
      expect(resumed.initialTimeline).toEqual([]);
      const history = [];
      for await (const event of resumed.streamHistory()) history.push(event);
      expect(history).toEqual([
        { type: "timeline", provider: "opencode", ...original.initialTimeline![0] },
      ]);
      expect(resumed.describePersistence()?.metadata?.openCodeRuntimeNotices).toEqual(
        handle.metadata?.openCodeRuntimeNotices,
      );
    } finally {
      await resumed.close();
    }
  } finally {
    await client.shutdown();
  }
});

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
  });
  try {
    await writeFile(script, initialSource);
    expect((await client.listFeatures({ provider: "opencode", cwd: root }))[0]?.label).toBe(
      "Auto Accept",
    );
    await writeFile(script, 'console.log("opencode v2.0.10")');
    expect((await client.listFeatures({ provider: "opencode", cwd: root }))[0]?.label).toBe(
      "Auto-accept",
    );
  } finally {
    await client.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("appends a first notice after old history and records a changed major version", async () => {
  const { withOpenCodeRuntimeNotice } = await import("./runtime-notice.js");
  const { V2Harness } = await import("./test-utils/v2-harness.js");
  const { OpenCodeV2AgentClient } = await import("./v2/agent.js");
  const { createTestLogger } = await import("../../../../test-utils/test-logger.js");
  const harness = new V2Harness();
  harness.history.push({ id: "old", type: "user", text: "Earlier prompt", time: { created: 1 } });
  const client = new OpenCodeV2AgentClient({
    logger: createTestLogger(),
    runtime: harness.runtime,
  });
  const previous = {
    provider: "opencode",
    sessionId: "session",
    metadata: { cwd: "/tmp/project" },
  };
  const session = withOpenCodeRuntimeNotice(await client.resumeSession(previous), 2, previous);
  try {
    const history = [];
    for await (const event of session.streamHistory()) history.push(event);
    expect(history).toEqual([
      expect.objectContaining({
        type: "timeline",
        item: { type: "user_message", text: "Earlier prompt", messageId: "old" },
      }),
      expect.objectContaining({
        type: "timeline",
        item: { type: "notification", level: "info", message: "This chat uses OpenCode v2." },
      }),
    ]);
    await session.close();
    const v1Handle = {
      ...previous,
      metadata: {
        ...previous.metadata,
        openCodeRuntimeNotices: [{ major: 1, timestamp: "2026-01-01T00:00:00.000Z" }],
      },
    };
    const changed = withOpenCodeRuntimeNotice(await client.resumeSession(v1Handle), 2, v1Handle);
    try {
      expect(changed.initialTimeline?.map((entry) => entry.item)).toEqual([
        { type: "notification", level: "info", message: "This chat uses OpenCode v2." },
      ]);
      expect(changed.describePersistence()?.metadata?.openCodeRuntimeNotices).toHaveLength(2);
    } finally {
      await changed.close();
    }
  } finally {
    await session.close();
    await client.shutdown();
  }
});

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
      },
      { serverManager: new TrackedServerManager({ logger }) },
    );
    const legacy = new OpenCodeAgentClient(logger);
    const config = { provider: "opencode", cwd: root };
    try {
      expect(await client.listFeatures(config)).toEqual(await legacy.listFeatures(config));
    } finally {
      await client.shutdown();
      await legacy.shutdown();
      await rm(root, { recursive: true, force: true });
    }
    expect(legacyShutdown).toBe(true);
  },
  10000,
);
