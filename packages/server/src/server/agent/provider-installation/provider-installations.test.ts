import type {
  ProviderEvent,
  ProviderInstallation,
  ProviderInstallationContext,
  ProviderRegistration,
  ProviderUpdateResult,
} from "@getpaseo/plugin/server/provider";
import type {
  ProviderInstallationUpdate,
  ProviderInstallationUpdateProgress,
} from "@getpaseo/protocol/messages";
import { describe, expect, test } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { AgentClient, AgentClientInstallation } from "../agent-sdk-types.js";
import { ProviderSnapshotManager } from "../provider-snapshot-manager.js";
import { ProviderInstallations } from "./provider-installations.js";

const OPAQUE_VERSION = "  v1.2.3-beta+weird (build 7)\n";
const MISSING_COMMAND = "paseo-provider-installation-missing-binary";
const OPAQUE_VERSIONS = ["v9-nightly+abc", "  2.0 (LTS)\n"];
const OPAQUE_MESSAGE = "  Restart to finish updating\n";

function pluginProvider(
  installation: ProviderInstallation | undefined,
  command: readonly [string, ...string[]] = [process.execPath],
): ProviderRegistration {
  return {
    id: "installation-plugin",
    label: "Installation plugin",
    command,
    installation,
    async connect() {
      let listener: ((event: ProviderEvent) => void) | undefined;
      return {
        version: 1,
        capabilities: [],
        async send(input) {
          if (input.type === "catalog")
            listener?.({
              type: "catalog",
              requestId: input.requestId,
              catalog: { models: [{ id: "model", label: "Model" }], modes: [] },
            });
        },
        onEvent(next) {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
        async close() {},
      };
    },
  };
}

function builtinClient(installation: AgentClientInstallation | undefined): AgentClient {
  return {
    provider: "codex",
    capabilities: {
      supportsStreaming: false,
      supportsSessionPersistence: false,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: false,
    },
    installation,
    async createSession() {
      throw new Error("not opened by this test");
    },
    async resumeSession() {
      throw new Error("not opened by this test");
    },
    async fetchCatalog() {
      return { models: [], modes: [] };
    },
    async isAvailable() {
      return true;
    },
  };
}

function managerWith(input: { plugin?: ProviderRegistration; codex?: AgentClient }) {
  const manager = new ProviderSnapshotManager({
    logger: createTestLogger(),
    extraClients: input.codex ? { codex: input.codex } : {},
  });
  if (input.plugin) manager.replacePluginProviders([input.plugin]);
  return manager;
}

describe("provider installation", () => {
  test("exposes links and lets the plugin report not installed when its executable is missing", async () => {
    const contexts: ProviderInstallationContext[] = [];
    const manager = managerWith({
      plugin: pluginProvider(
        {
          installUrl: "https://example.com/install",
          updateUrl: "https://example.com/update",
          async inspect(context) {
            contexts.push(context);
            return context.launch?.resolved ? { status: "installed" } : { status: "not_installed" };
          },
        },
        [MISSING_COMMAND, "serve"],
      ),
    });
    try {
      await expect(manager.installations.inspect("installation-plugin")).resolves.toEqual({
        installUrl: "https://example.com/install",
        updateUrl: "https://example.com/update",
        inspection: { status: "not_installed" },
      });
      expect(contexts[0]?.launch).toEqual({
        command: MISSING_COMMAND,
        args: ["serve"],
        env: expect.objectContaining({ PATH: expect.any(String) }),
        resolved: false,
      });
    } finally {
      manager.destroy();
    }
  });

  test.each([
    {
      name: "plugin",
      manager: () =>
        managerWith({
          plugin: pluginProvider({
            installUrl: "https://example.com/install",
            async inspect({ launch }) {
              if (!launch?.resolved || launch.command !== process.execPath)
                throw new Error("Unexpected launch");
              return { status: "installed", version: OPAQUE_VERSION };
            },
          }),
        }),
      provider: "installation-plugin",
    },
    {
      name: "built-in",
      manager: () =>
        managerWith({
          codex: builtinClient({
            installUrl: "https://example.com/install",
            async inspect() {
              return { status: "installed", version: OPAQUE_VERSION };
            },
          }),
        }),
      provider: "codex",
    },
  ])("returns a $name provider's version string unchanged", async ({ manager, provider }) => {
    const providers = manager();
    try {
      await expect(providers.installations.inspect(provider)).resolves.toEqual({
        installUrl: "https://example.com/install",
        inspection: { status: "installed", version: OPAQUE_VERSION },
      });
    } finally {
      providers.destroy();
    }
  });

  test("keeps links and reports the failure when inspect throws", async () => {
    const manager = managerWith({
      plugin: pluginProvider({
        installUrl: "https://example.com/install",
        async inspect() {
          throw new Error("version probe exploded");
        },
      }),
    });
    try {
      await expect(manager.installations.inspect("installation-plugin")).resolves.toEqual({
        installUrl: "https://example.com/install",
        inspection: { status: "error", message: "version probe exploded" },
      });
    } finally {
      manager.destroy();
    }
  });

  test("returns null for a provider without an installation contract", async () => {
    const manager = managerWith({ plugin: pluginProvider(undefined) });
    try {
      await expect(manager.installations.inspect("installation-plugin")).resolves.toBeNull();
      await expect(manager.installations.inspect("not-a-provider")).rejects.toThrow(
        "Provider not-a-provider is not configured",
      );
    } finally {
      manager.destroy();
    }
  });

  test("availability and discovery never wait on inspect", async () => {
    let inspectCalls = 0;
    const manager = managerWith({
      plugin: pluginProvider({
        inspect() {
          inspectCalls += 1;
          return new Promise(() => {});
        },
      }),
    });
    try {
      void manager.installations.inspect("installation-plugin");
      const entry = await manager.getProvider({ provider: "installation-plugin", wait: true });
      expect(entry.status).toBe("ready");
      expect(inspectCalls).toBe(1);
    } finally {
      manager.destroy();
    }
  });

  test.each([
    {
      name: "plugin",
      manager: () =>
        managerWith({
          plugin: pluginProvider({
            async checkForUpdates({ launch }) {
              if (!launch?.resolved) throw new Error("Unexpected launch");
              return { status: "available", versions: OPAQUE_VERSIONS, message: OPAQUE_MESSAGE };
            },
          }),
        }),
      provider: "installation-plugin",
    },
    {
      name: "built-in",
      manager: () =>
        managerWith({
          codex: builtinClient({
            async checkForUpdates() {
              return { status: "available", versions: OPAQUE_VERSIONS, message: OPAQUE_MESSAGE };
            },
          }),
        }),
      provider: "codex",
    },
  ])("returns a $name provider's available versions unchanged", async ({ manager, provider }) => {
    const providers = manager();
    try {
      await expect(providers.installations.checkForUpdates(provider)).resolves.toEqual({
        status: "available",
        versions: OPAQUE_VERSIONS,
        message: OPAQUE_MESSAGE,
      });
    } finally {
      providers.destroy();
    }
  });

  test.each([
    {
      name: "returns unknown",
      checkForUpdates: async () => ({ status: "unknown" as const, message: "Offline" }),
      expected: { status: "unknown", message: "Offline" },
    },
    {
      name: "throws",
      checkForUpdates: async (): Promise<never> => {
        throw new Error("release feed exploded");
      },
      expected: { status: "error", message: "release feed exploded" },
    },
    {
      name: "breaks the contract",
      checkForUpdates: async () => ({ status: "up_to_date" }) as never,
      expected: { status: "error", message: expect.stringContaining("status") },
    },
  ])("reports an inconclusive check when the provider $name", async (input) => {
    const manager = managerWith({
      plugin: pluginProvider({ checkForUpdates: input.checkForUpdates }),
    });
    try {
      await expect(manager.installations.checkForUpdates("installation-plugin")).resolves.toEqual(
        input.expected,
      );
    } finally {
      manager.destroy();
    }
  });

  test("returns null when the provider cannot check for updates", async () => {
    const manager = managerWith({
      plugin: pluginProvider({ installUrl: "https://example.com/install" }),
    });
    try {
      await expect(
        manager.installations.checkForUpdates("installation-plugin"),
      ).resolves.toBeNull();
      await expect(manager.installations.checkForUpdates("not-a-provider")).rejects.toThrow(
        "Provider not-a-provider is not configured",
      );
    } finally {
      manager.destroy();
    }
  });

  test("availability, discovery and the installed version never wait on an update check", async () => {
    let checks = 0;
    const manager = managerWith({
      plugin: pluginProvider({
        async inspect() {
          return { status: "installed", version: "1.0.0" };
        },
        checkForUpdates() {
          checks += 1;
          return new Promise(() => {});
        },
      }),
    });
    try {
      void manager.installations.checkForUpdates("installation-plugin");
      const entry = await manager.getProvider({ provider: "installation-plugin", wait: true });
      expect(entry.status).toBe("ready");
      await expect(manager.installations.inspect("installation-plugin")).resolves.toEqual({
        inspection: { status: "installed", version: "1.0.0" },
      });
      expect(checks).toBe(1);
    } finally {
      manager.destroy();
    }
  });
});

describe("ProviderInstallations", () => {
  function counting(
    inspect: NonNullable<AgentClientInstallation["inspect"]>,
    options: { now?: () => number; inspectTimeoutMs?: number } = {},
  ) {
    let calls = 0;
    const client = builtinClient({
      inspect(context) {
        calls += 1;
        return inspect(context);
      },
    });
    const installations = new ProviderInstallations({
      logger: createTestLogger(),
      resolveClient: (provider) => (provider === "codex" ? client : null),
      ...options,
    });
    return { installations, calls: () => calls };
  }

  test("shares concurrent reads, caches briefly, and refresh asks again", async () => {
    let time = 0;
    const { installations, calls } = counting(
      async () => ({ status: "installed", version: `v${time}` }),
      { now: () => time },
    );
    const [first, second] = await Promise.all([
      installations.inspect("codex"),
      installations.inspect("codex"),
    ]);
    expect(first).toEqual(second);
    expect(calls()).toBe(1);

    time = 1_000;
    await expect(installations.inspect("codex")).resolves.toEqual({
      inspection: { status: "installed", version: "v0" },
    });
    expect(calls()).toBe(1);

    await expect(installations.inspect("codex", { refresh: true })).resolves.toEqual({
      inspection: { status: "installed", version: "v1000" },
    });
    expect(calls()).toBe(2);

    time = 1_000_000;
    await installations.inspect("codex");
    expect(calls()).toBe(3);
  });

  function countingUpdates(
    checkForUpdates: NonNullable<AgentClientInstallation["checkForUpdates"]>,
    options: { now?: () => number; updateCheckTimeoutMs?: number } = {},
  ) {
    let calls = 0;
    const client = builtinClient({
      checkForUpdates(context) {
        calls += 1;
        return checkForUpdates(context);
      },
    });
    const installations = new ProviderInstallations({
      logger: createTestLogger(),
      resolveClient: (provider) => (provider === "codex" ? client : null),
      updateCheckCacheMs: 3_600_000,
      inspectCacheMs: 30_000,
      ...options,
    });
    return { installations, calls: () => calls };
  }

  test("shares concurrent update checks, holds an answer for the long cache, and refresh asks again", async () => {
    let time = 0;
    const { installations, calls } = countingUpdates(
      async () => ({ status: "available", versions: [`v${time}`] }),
      { now: () => time },
    );
    const [first, second] = await Promise.all([
      installations.checkForUpdates("codex"),
      installations.checkForUpdates("codex"),
    ]);
    expect(first).toEqual(second);
    expect(calls()).toBe(1);

    time = 3_000_000;
    await expect(installations.checkForUpdates("codex")).resolves.toEqual({
      status: "available",
      versions: ["v0"],
    });
    expect(calls()).toBe(1);

    await expect(installations.checkForUpdates("codex", { refresh: true })).resolves.toEqual({
      status: "available",
      versions: ["v3000000"],
    });
    expect(calls()).toBe(2);

    time = 3_000_000 + 3_600_000;
    await installations.checkForUpdates("codex");
    expect(calls()).toBe(3);
  });

  test("retries an inconclusive update check after the short cache", async () => {
    let time = 0;
    const { installations, calls } = countingUpdates(async () => ({ status: "unknown" }), {
      now: () => time,
    });
    await installations.checkForUpdates("codex");
    time = 29_000;
    await installations.checkForUpdates("codex");
    expect(calls()).toBe(1);
    time = 31_000;
    await installations.checkForUpdates("codex");
    expect(calls()).toBe(2);
  });

  test("keeps update checks and inspection in separate caches", async () => {
    const client = builtinClient({
      async inspect() {
        return { status: "installed", version: "1.0.0" };
      },
      async checkForUpdates() {
        return { status: "current" };
      },
    });
    const installations = new ProviderInstallations({
      logger: createTestLogger(),
      resolveClient: () => client,
    });
    await expect(installations.checkForUpdates("codex")).resolves.toEqual({ status: "current" });
    await expect(installations.inspect("codex")).resolves.toEqual({
      inspection: { status: "installed", version: "1.0.0" },
    });
  });

  test("asks for updates again once the installed version changes", async () => {
    let time = 0;
    let installed = "1.0.0";
    let checks = 0;
    const client = builtinClient({
      async inspect() {
        // The app sends inspect and check together; the check must not answer first.
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { status: "installed", version: installed };
      },
      async checkForUpdates() {
        checks += 1;
        return installed === "1.0.0"
          ? { status: "available", versions: ["2.0.0"] }
          : { status: "current" };
      },
    });
    const installations = new ProviderInstallations({
      logger: createTestLogger(),
      resolveClient: () => client,
      inspectCacheMs: 30_000,
      updateCheckCacheMs: 3_600_000,
      now: () => time,
    });
    const together = () =>
      Promise.all([installations.inspect("codex"), installations.checkForUpdates("codex")]);
    await expect(together()).resolves.toEqual([
      { inspection: { status: "installed", version: "1.0.0" } },
      { status: "available", versions: ["2.0.0"] },
    ]);

    // The CLI updated itself outside Paseo.
    installed = "2.0.0";
    time = 31_000;
    await expect(together()).resolves.toEqual([
      { inspection: { status: "installed", version: "2.0.0" } },
      { status: "current" },
    ]);
    expect(checks).toBe(2);

    // The same version again keeps the long-cached answer.
    time = 62_000;
    await together();
    expect(checks).toBe(2);
  });

  test("aborts a slow update check and reports it as an error", async () => {
    let aborted = false;
    function waitForAbort(signal: AbortSignal) {
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      });
    }
    const { installations } = countingUpdates(({ signal }) => waitForAbort(signal), {
      updateCheckTimeoutMs: 10,
    });
    await expect(installations.checkForUpdates("codex")).resolves.toEqual({
      status: "error",
      message: "Timed out after 10ms",
    });
    expect(aborted).toBe(true);
  });

  test("aborts a slow inspect and reports it as an error", async () => {
    let aborted = false;
    function waitForAbort(signal: AbortSignal) {
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      });
    }
    const { installations } = counting(({ signal }) => waitForAbort(signal), {
      inspectTimeoutMs: 10,
    });
    await expect(installations.inspect("codex")).resolves.toEqual({
      inspection: { status: "error", message: "Timed out after 10ms" },
    });
    expect(aborted).toBe(true);
  });
});

describe("provider updates", () => {
  function updating(
    update: NonNullable<AgentClientInstallation["update"]>,
    options: {
      inspect?: AgentClientInstallation["inspect"];
      refreshProvider?: (provider: string) => Promise<void>;
      updateOutputLimit?: number;
    } = {},
  ) {
    let calls = 0;
    const client = builtinClient({
      updateUrl: "https://example.com/update",
      inspect: options.inspect,
      update(context) {
        calls += 1;
        return update(context);
      },
    });
    const installations = new ProviderInstallations({
      logger: createTestLogger(),
      resolveClient: (provider) => (provider === "codex" ? client : null),
      refreshProvider: options.refreshProvider,
      updateOutputLimit: options.updateOutputLimit,
    });
    const progress: ProviderInstallationUpdateProgress[] = [];
    installations.observeUpdates("codex", (event) => progress.push(event));
    return { installations, progress, calls: () => calls };
  }

  function settled(installations: ProviderInstallations): Promise<ProviderInstallationUpdate> {
    return new Promise((resolve) => {
      const stop = installations.observeUpdates("codex", (event) => {
        if (event.operation.status === "running") return;
        stop();
        resolve(installations.getUpdate("codex")!);
      });
    });
  }

  test("passes output and the success message through unchanged, in order", async () => {
    const { installations, progress } = updating(async ({ report }) => {
      report({ type: "message", text: OPAQUE_MESSAGE });
      report({ type: "stdout", text: "  added 1 package\r\n" });
      report({ type: "stderr", text: "npm warn \u001b[33mdeprecated\u001b[0m\n" });
      report({ type: "stdout", text: "" });
      return { status: "succeeded", message: OPAQUE_MESSAGE };
    });
    const done = settled(installations);
    const started = installations.update("codex");
    expect(started.operation.status).toBe("running");

    const update = await done;
    const output = [
      { type: "message", text: OPAQUE_MESSAGE },
      { type: "stdout", text: "  added 1 package\r\n" },
      { type: "stderr", text: "npm warn \u001b[33mdeprecated\u001b[0m\n" },
      { type: "stdout", text: "" },
    ];
    expect(update).toEqual({
      operation: {
        status: "succeeded",
        id: started.operation.id,
        startedAt: expect.any(String),
        finishedAt: expect.any(String),
        message: OPAQUE_MESSAGE,
      },
      output,
    });
    expect(progress.map((event) => event.operation.status)).toEqual([
      "running",
      "running",
      "running",
      "running",
      "running",
      "succeeded",
    ]);
    expect(progress.flatMap((event) => event.output)).toEqual(output);
  });

  test("reports a failure with the provider's message and keeps its output", async () => {
    const { installations } = updating(async ({ report }) => {
      report({ type: "stdout", text: "Updating Codex via `npm install -g @openai/codex`...\n" });
      report({ type: "stderr", text: "npm error code EACCES\n" });
      return { status: "failed", message: OPAQUE_MESSAGE };
    });
    const done = settled(installations);
    installations.update("codex");
    await expect(done).resolves.toEqual({
      operation: expect.objectContaining({ status: "failed", message: OPAQUE_MESSAGE }),
      output: [
        { type: "stdout", text: "Updating Codex via `npm install -g @openai/codex`...\n" },
        { type: "stderr", text: "npm error code EACCES\n" },
      ],
    });
  });

  test("turns a throw into a failure with its message and keeps earlier output", async () => {
    const { installations } = updating(async ({ report }) => {
      report({ type: "stdout", text: "step 1\n" });
      throw new Error(OPAQUE_MESSAGE);
    });
    const done = settled(installations);
    installations.update("codex");
    await expect(done).resolves.toEqual({
      operation: expect.objectContaining({ status: "failed", message: OPAQUE_MESSAGE }),
      output: [{ type: "stdout", text: "step 1\n" }],
    });
  });

  test("a second request while an update runs joins it instead of starting another", async () => {
    let finish!: () => void;
    const { installations, calls } = updating(async ({ report }) => {
      report({ type: "stdout", text: "working\n" });
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { status: "succeeded" };
    });
    const first = installations.update("codex");
    const second = installations.update("codex");
    expect(second.operation.id).toBe(first.operation.id);
    expect(second.output).toEqual([{ type: "stdout", text: "working\n" }]);
    expect(calls()).toBe(1);

    const done = settled(installations);
    finish();
    await expect(done).resolves.toMatchObject({ operation: { status: "succeeded" } });
    const third = installations.update("codex");
    expect(third.operation.id).not.toBe(first.operation.id);
    expect(calls()).toBe(2);
  });

  test("after success the next read asks the provider again and discovery refreshes", async () => {
    let version = "1.0.0";
    const refreshed: string[] = [];
    const { installations } = updating(
      async () => {
        version = "2.0.0";
        return { status: "succeeded" };
      },
      {
        inspect: async () => ({ status: "installed", version }),
        refreshProvider: async (provider) => {
          refreshed.push(provider);
        },
      },
    );
    await expect(installations.inspect("codex")).resolves.toMatchObject({
      inspection: { version: "1.0.0" },
    });
    const done = settled(installations);
    installations.update("codex");
    await done;
    await expect(installations.inspect("codex")).resolves.toMatchObject({
      inspection: { version: "2.0.0" },
    });
    expect(refreshed).toEqual(["codex"]);
  });

  test("a failed refresh after success still reports success; a failure keeps the caches", async () => {
    let version = "1.0.0";
    let result: "succeeded" | "failed" = "failed";
    const { installations } = updating(
      async () => {
        version = "2.0.0";
        return result === "succeeded" ? { status: result } : { status: result, message: "no" };
      },
      {
        inspect: async () => ({ status: "installed", version }),
        refreshProvider: async () => {
          throw new Error("discovery failed");
        },
      },
    );
    await installations.inspect("codex");
    let done = settled(installations);
    installations.update("codex");
    await done;
    await expect(installations.inspect("codex")).resolves.toMatchObject({
      inspection: { version: "1.0.0" },
    });

    result = "succeeded";
    done = settled(installations);
    installations.update("codex");
    await expect(done).resolves.toMatchObject({ operation: { status: "succeeded" } });
  });

  test("retains the most recent output within the limit and marks the drop", async () => {
    const { installations, progress } = updating(
      async ({ report }) => {
        report({ type: "stdout", text: "aaaa" });
        report({ type: "stdout", text: "bbbb" });
        report({ type: "stderr", text: "cccc" });
        report({ type: "stdout", text: "0123456789XYZ" });
        return { status: "succeeded" };
      },
      { updateOutputLimit: 10 },
    );
    const done = settled(installations);
    installations.update("codex");
    const update = await done;
    expect(update.output).toEqual([{ type: "stdout", text: "3456789XYZ" }]);
    expect(update.truncated).toBe(true);
    expect(progress.flatMap((event) => event.output).at(-1)).toEqual({
      type: "stdout",
      text: "3456789XYZ",
    });

    const partial = updating(
      async ({ report }) => {
        report({ type: "stdout", text: "aaaa" });
        report({ type: "stdout", text: "bbbb" });
        report({ type: "stderr", text: "cccc" });
        return { status: "succeeded" };
      },
      { updateOutputLimit: 10 },
    );
    const partialDone = settled(partial.installations);
    partial.installations.update("codex");
    await expect(partialDone).resolves.toMatchObject({
      output: [
        { type: "stdout", text: "bbbb" },
        { type: "stderr", text: "cccc" },
      ],
      truncated: true,
    });
  });

  test("advertises the update only when the provider declares one", async () => {
    const { installations } = updating(async () => ({ status: "succeeded" }));
    await expect(installations.inspect("codex")).resolves.toEqual({
      updateUrl: "https://example.com/update",
      canUpdate: true,
    });

    const plain = new ProviderInstallations({
      logger: createTestLogger(),
      resolveClient: () => builtinClient({ updateUrl: "https://example.com/update" }),
    });
    await expect(plain.inspect("codex")).resolves.toEqual({
      updateUrl: "https://example.com/update",
    });
    expect(() => plain.update("codex")).toThrow("Provider codex cannot update itself");
    expect(plain.getUpdate("codex")).toBeNull();
  });

  test("close aborts a running update, which settles with the provider's answer", async () => {
    function failOnAbort(signal: AbortSignal): Promise<ProviderUpdateResult> {
      return new Promise((resolve) => {
        const stopped = () =>
          resolve({ status: "failed", message: `stopped: ${String(signal.reason)}` });
        signal.addEventListener("abort", stopped);
      });
    }
    const { installations } = updating(({ signal }) => failOnAbort(signal));
    const done = settled(installations);
    installations.update("codex");
    installations.close();
    await expect(done).resolves.toMatchObject({
      operation: { status: "failed", message: "stopped: Error: The daemon is stopping" },
    });
  });
});
