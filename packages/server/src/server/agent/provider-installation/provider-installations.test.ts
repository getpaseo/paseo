import type {
  ProviderEvent,
  ProviderInstallation,
  ProviderInstallationContext,
  ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import { describe, expect, test } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { AgentClient, AgentClientInstallation } from "../agent-sdk-types.js";
import { ProviderSnapshotManager } from "../provider-snapshot-manager.js";
import { ProviderInstallations } from "./provider-installations.js";

const OPAQUE_VERSION = "  v1.2.3-beta+weird (build 7)\n";
const MISSING_COMMAND = "paseo-provider-installation-missing-binary";

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
