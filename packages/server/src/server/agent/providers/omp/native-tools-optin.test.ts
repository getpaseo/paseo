// The native-tools capability was a constant, so every omp provider advertised
// it and the only control was a daemon-wide flag named for MCP injection. A
// deployment running several omp providers in different roles needs the
// opposite: a worker-style provider holding no orchestration tools while a
// coordinator does, which is a per-provider decision. Turning MCP injection off
// must not remove native tools along with it.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { MutableDaemonConfigSchema } from "@getpaseo/protocol/messages";
import { afterEach, describe, expect, it } from "vitest";

import { DaemonConfigStore } from "../../../daemon-config-store.js";
import { loadPersistedConfig } from "../../../persisted-config.js";

import { OmpAgentClient } from "./agent.js";
import { resolveOmpProviderParams } from "./provider-config.js";

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
} as never;

function capabilitiesFor(providerParams: unknown): boolean {
  return new OmpAgentClient({ logger, providerParams }).capabilities.supportsNativePaseoTools;
}

describe("omp native Paseo tools are a per-provider decision", () => {
  it("defaults to enabled, which is the behaviour before the field existed", () => {
    expect(resolveOmpProviderParams({}).runtimeProviderParams.paseoTools).toBe(true);
    expect(capabilitiesFor(undefined)).toBe(true);
  });

  it("lets a provider opt out, so a Peer seat can hold no orchestration tools", () => {
    expect(resolveOmpProviderParams({ paseoTools: false }).runtimeProviderParams.paseoTools).toBe(
      false,
    );
    expect(capabilitiesFor({ paseoTools: false })).toBe(false);
  });

  it("keeps the opt-in explicit and independent of the other provider params", () => {
    expect(capabilitiesFor({ sessionDir: "/tmp/x", paseoTools: true })).toBe(true);
    expect(capabilitiesFor({ sessionDir: "/tmp/x" })).toBe(true);
  });

  it("rejects an unknown provider param rather than ignoring it", () => {
    expect(() => resolveOmpProviderParams({ paseoTool: true })).toThrow();
  });
});

// `daemon.mcp.nativeAgentTools` is a setting, not just a startup read: it has to
// exist on the mutable surface, be seeded from the resolved config, survive the
// patch whitelist, and persist. Without the whole chain the field looks like it
// works — the daemon reports nothing for it and a live change is undone by the
// next restart.
describe("daemon.mcp.nativeAgentTools is a durable setting", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function storeWith(nativeAgentTools: boolean): {
    store: DaemonConfigStore;
    paseoHome: string;
  } {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-native-agent-tools-"));
    tempDirs.push(paseoHome);
    return {
      paseoHome,
      store: new DaemonConfigStore(paseoHome, {
        relay: { enabled: false },
        mcp: { injectIntoAgents: false, nativeAgentTools },
        browserTools: { enabled: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      }),
    };
  }

  it("reports the seeded value", () => {
    expect(storeWith(true).store.get().mcp.nativeAgentTools).toBe(true);
  });

  it("emits its field change when patched", () => {
    const { store } = storeWith(true);
    const changes: unknown[] = [];
    store.onFieldChange("mcp.nativeAgentTools", (value) => changes.push(value));

    store.patch({ mcp: { nativeAgentTools: false } });

    expect(changes).toEqual([false]);
  });

  it("persists the change, so a restart does not undo it", () => {
    const { store, paseoHome } = storeWith(true);

    store.patch({ mcp: { nativeAgentTools: false } });

    expect(loadPersistedConfig(paseoHome).daemon?.mcp?.nativeAgentTools).toBe(false);
  });

  it("is untouched when only injectIntoAgents is patched", () => {
    const { store, paseoHome } = storeWith(true);
    const changes: unknown[] = [];
    store.onFieldChange("mcp.nativeAgentTools", (value) => changes.push(value));

    store.patch({ mcp: { injectIntoAgents: true } });

    expect(changes).toEqual([]);
    expect(store.get().mcp.nativeAgentTools).toBe(true);
  });

  it("is declared on the mutable schema rather than passed through", () => {
    expect(
      MutableDaemonConfigSchema.parse({
        mcp: { injectIntoAgents: false, nativeAgentTools: false },
        providers: {},
      }).mcp.nativeAgentTools,
    ).toBe(false);
    expect(
      MutableDaemonConfigSchema.parse({ mcp: { injectIntoAgents: false }, providers: {} }).mcp
        .nativeAgentTools,
    ).toBeUndefined();
    expect(() =>
      MutableDaemonConfigSchema.parse({
        mcp: { injectIntoAgents: false, nativeAgentTools: "yes" },
        providers: {},
      }),
    ).toThrow();
  });
});
