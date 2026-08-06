import { describe, expect, it } from "vitest";
import {
  resolvePluginsSupport,
  runPluginAction,
  type PluginActionEffects,
  type PluginActionKind,
  type PluginActionsPort,
} from "./model";

interface Call {
  method: string;
  input: unknown;
}

/** In-memory stand-in for the daemon client, colocated with the module it fakes. */
function createFakePort(
  results: Partial<Record<"setEnabled" | "install" | "uninstall", { error?: string | null }>> = {},
): PluginActionsPort & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async setEnabled(input) {
      calls.push({ method: "setEnabled", input });
      return results.setEnabled ?? {};
    },
    async install(input) {
      calls.push({ method: "install", input });
      return results.install ?? {};
    },
    async uninstall(input) {
      calls.push({ method: "uninstall", input });
      return results.uninstall ?? {};
    },
  };
}

function createRecorder() {
  const events: string[] = [];
  const errors: Record<string, string | null> = {};
  const pending: Record<string, PluginActionKind | null> = {};
  const effects: PluginActionEffects = {
    setPending(pluginId, kind) {
      pending[pluginId] = kind;
      events.push(`pending:${pluginId}:${kind ?? "none"}`);
    },
    setError(pluginId, message) {
      errors[pluginId] = message;
      events.push(`error:${pluginId}:${message ?? "none"}`);
    },
    notifySuccess(kind) {
      events.push(`success:${kind}`);
    },
    refresh() {
      events.push("refresh");
    },
  };
  return { events, errors, pending, effects };
}

const DISCONNECTED = "Host disconnected";

describe("resolvePluginsSupport", () => {
  it("is unknown when there is no host at all", () => {
    expect(
      resolvePluginsSupport({ serverId: null, hasServerInfo: false, hasPluginsFeature: false }),
    ).toBe("unknown");
  });

  it("is unknown for a host that has not sent server_info yet", () => {
    expect(
      resolvePluginsSupport({ serverId: "host-1", hasServerInfo: false, hasPluginsFeature: false }),
    ).toBe("unknown");
  });

  it("is unsupported only once a host has answered without the capability", () => {
    expect(
      resolvePluginsSupport({ serverId: "host-1", hasServerInfo: true, hasPluginsFeature: false }),
    ).toBe("unsupported");
  });

  it("is supported when the host advertises the capability", () => {
    expect(
      resolvePluginsSupport({ serverId: "host-1", hasServerInfo: true, hasPluginsFeature: true }),
    ).toBe("supported");
  });
});

describe("runPluginAction", () => {
  it("installs, toasts, and refreshes the list on success", async () => {
    const port = createFakePort();
    const recorder = createRecorder();

    await runPluginAction({
      request: { kind: "install", pluginId: "csv-table" },
      port,
      effects: recorder.effects,
      disconnectedMessage: DISCONNECTED,
    });

    expect(port.calls).toEqual([{ method: "install", input: { pluginId: "csv-table" } }]);
    expect(recorder.events).toEqual([
      "error:csv-table:none",
      "pending:csv-table:install",
      "success:install",
      "pending:csv-table:none",
      "refresh",
    ]);
  });

  it("keeps a dismissible error and still refreshes when the install fails", async () => {
    const port = createFakePort({ install: { error: "sha256 mismatch" } });
    const recorder = createRecorder();

    await runPluginAction({
      request: { kind: "install", pluginId: "csv-table" },
      port,
      effects: recorder.effects,
      disconnectedMessage: DISCONNECTED,
    });

    expect(recorder.errors["csv-table"]).toBe("sha256 mismatch");
    expect(recorder.pending["csv-table"]).toBeNull();
    expect(recorder.events).toEqual([
      "error:csv-table:none",
      "pending:csv-table:install",
      "error:csv-table:sha256 mismatch",
      "pending:csv-table:none",
      "refresh",
    ]);
  });

  it("uninstalls and reports its own failure", async () => {
    const port = createFakePort();
    const ok = createRecorder();
    await runPluginAction({
      request: { kind: "uninstall", pluginId: "csv-table" },
      port,
      effects: ok.effects,
      disconnectedMessage: DISCONNECTED,
    });
    expect(port.calls).toEqual([{ method: "uninstall", input: { pluginId: "csv-table" } }]);
    expect(ok.events).toContain("success:uninstall");

    const failing = createRecorder();
    await runPluginAction({
      request: { kind: "uninstall", pluginId: "csv-table" },
      port: createFakePort({ uninstall: { error: "EACCES" } }),
      effects: failing.effects,
      disconnectedMessage: DISCONNECTED,
    });
    expect(failing.errors["csv-table"]).toBe("EACCES");
    expect(failing.events).not.toContain("success:uninstall");
  });

  it("sends the enabled flag the requested kind implies and acknowledges both", async () => {
    const enabling = createFakePort();
    const enabled = createRecorder();
    await runPluginAction({
      request: { kind: "enable", pluginId: "csv-table" },
      port: enabling,
      effects: enabled.effects,
      disconnectedMessage: DISCONNECTED,
    });
    expect(enabling.calls).toEqual([
      { method: "setEnabled", input: { pluginId: "csv-table", enabled: true } },
    ]);
    expect(enabled.events).toContain("success:enable");

    const disabling = createFakePort();
    const disabled = createRecorder();
    await runPluginAction({
      request: { kind: "disable", pluginId: "csv-table" },
      port: disabling,
      effects: disabled.effects,
      disconnectedMessage: DISCONNECTED,
    });
    expect(disabling.calls).toEqual([
      { method: "setEnabled", input: { pluginId: "csv-table", enabled: false } },
    ]);
    expect(disabled.events).toContain("success:disable");
  });

  it("reports the enable failure instead of a silent no-op", async () => {
    const recorder = createRecorder();

    await runPluginAction({
      request: { kind: "enable", pluginId: "csv-table" },
      port: createFakePort({ setEnabled: { error: "Requires Paseo >= 9.0.0" } }),
      effects: recorder.effects,
      disconnectedMessage: DISCONNECTED,
    });

    expect(recorder.errors["csv-table"]).toBe("Requires Paseo >= 9.0.0");
    expect(recorder.events).toContain("refresh");
  });

  it("surfaces the disconnected message when there is no client", async () => {
    const recorder = createRecorder();

    await runPluginAction({
      request: { kind: "enable", pluginId: "csv-table" },
      port: null,
      effects: recorder.effects,
      disconnectedMessage: DISCONNECTED,
    });

    expect(recorder.errors["csv-table"]).toBe(DISCONNECTED);
    expect(recorder.pending["csv-table"]).toBeNull();
  });

  it("keeps two concurrent installs on their own pending keys", async () => {
    const recorder = createRecorder();
    const port = createFakePort();

    await Promise.all([
      runPluginAction({
        request: { kind: "install", pluginId: "alpha" },
        port,
        effects: recorder.effects,
        disconnectedMessage: DISCONNECTED,
      }),
      runPluginAction({
        request: { kind: "install", pluginId: "beta" },
        port,
        effects: recorder.effects,
        disconnectedMessage: DISCONNECTED,
      }),
    ]);

    expect(port.calls).toEqual([
      { method: "install", input: { pluginId: "alpha" } },
      { method: "install", input: { pluginId: "beta" } },
    ]);
    expect(recorder.pending).toEqual({ alpha: null, beta: null });
    expect(recorder.events.filter((event) => event.startsWith("pending:alpha"))).toEqual([
      "pending:alpha:install",
      "pending:alpha:none",
    ]);
  });
});
