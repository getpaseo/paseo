import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addAbortSignal, PassThrough, Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentHooksAreInstalled,
  installAgentHooks,
  resolveAgentHookConfigPath,
  uninstallAgentHooks,
} from "../agent-hook-installer.js";
import { opencodeAgentHookProvider } from "./opencode.js";
import { OPENCODE_PLUGIN_SOURCE } from "./opencode-plugin.js";

const temporaryDirs: string[] = [];

afterEach(() => {
  while (temporaryDirs.length > 0) {
    const dir = temporaryDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirs.push(dir);
  return dir;
}

describe("OpenCode terminal agent hooks", () => {
  it("installs a self-contained OpenCode plugin idempotently", () => {
    const configDir = createTempDir("paseo-opencode-config-");

    const firstInstall = installAgentHooks(opencodeAgentHookProvider, { configDir });
    const secondInstall = installAgentHooks(opencodeAgentHookProvider, { configDir });

    expect(firstInstall.configPath).toBe(join(configDir, "plugins", "paseo-terminal-activity.js"));
    expect(firstInstall.changed).toBe(true);
    expect(secondInstall.changed).toBe(false);
    expect(readFileSync(firstInstall.configPath, "utf8")).toBe(OPENCODE_PLUGIN_SOURCE);
    expect(agentHooksAreInstalled(opencodeAgentHookProvider, { configDir })).toBe(true);
  });

  it.each(["succeeded", "failed", "interrupted"])(
    "reports OpenCode 2 execution start and %s as running then idle",
    async (outcome) => {
      const { plugin, commands } = loadInstalledPlugin();
      const events = Readable.from([
        { type: "session.execution.started", data: { sessionID: "session-1" } },
        { type: `session.execution.${outcome}`, data: { sessionID: "session-1" } },
      ]);

      const dispose = plugin.setup({ event: { subscribe: () => events } });
      await finished(events);
      dispose();

      expect(commands).toEqual([
        ["paseo", "hooks", "opencode", "session.status.busy"],
        ["paseo", "hooks", "opencode", "session.status.idle"],
      ]);
    },
  );

  it("reports OpenCode 1 status and permission events through server()", async () => {
    const { plugin, commands } = loadInstalledPlugin();
    const hooks = plugin.server();
    for (const event of [
      { type: "session.status", properties: { status: { type: "busy" } } },
      { type: "permission.asked" },
      { type: "permission.replied" },
      { type: "session.status", properties: { status: { type: "retry" } } },
      { type: "session.status", properties: { status: { type: "idle" } } },
      { type: "session.execution.started", data: { sessionID: "session-1" } },
      { type: "message.updated" },
    ]) {
      await hooks.event({ event });
    }

    expect(plugin.id).toBe("paseo-terminal-activity");
    expect(commands).toEqual([
      ["paseo", "hooks", "opencode", "session.status.busy"],
      ["paseo", "hooks", "opencode", "permission.asked"],
      ["paseo", "hooks", "opencode", "permission.replied"],
      ["paseo", "hooks", "opencode", "session.status.retry"],
      ["paseo", "hooks", "opencode", "session.status.idle"],
    ]);
  });

  it("reports OpenCode 2 permission events and ignores V1 status snapshots", async () => {
    const { plugin, commands } = loadInstalledPlugin();
    const events = Readable.from([
      { type: "permission.asked", data: { sessionID: "session-1" } },
      { type: "permission.replied", data: { sessionID: "session-1" } },
      { type: "session.status", properties: { status: { type: "busy" } } },
      { type: "session.text.delta", data: { sessionID: "session-1" } },
    ]);

    const dispose = plugin.setup({ event: { subscribe: () => events } });
    await finished(events);
    dispose();

    expect(commands).toEqual([
      ["paseo", "hooks", "opencode", "permission.asked"],
      ["paseo", "hooks", "opencode", "permission.replied"],
    ]);
  });

  it("preserves activity order when the host dispatches events concurrently", async () => {
    let finishFirstHook = () => {};
    const firstExit = new Promise<number>((resolve) => {
      finishFirstHook = () => resolve(0);
    });
    const { plugin, commands } = loadInstalledPlugin("terminal-1", firstExit);
    const hooks = plugin.server();

    const working = hooks.event({
      event: { type: "session.status", properties: { status: { type: "busy" } } },
    });
    const idle = hooks.event({
      event: { type: "session.status", properties: { status: { type: "idle" } } },
    });
    await Promise.resolve();
    expect(commands).toEqual([["paseo", "hooks", "opencode", "session.status.busy"]]);

    finishFirstHook();
    await Promise.all([working, idle]);
    expect(commands).toEqual([
      ["paseo", "hooks", "opencode", "session.status.busy"],
      ["paseo", "hooks", "opencode", "session.status.idle"],
    ]);
  });

  it("stops the OpenCode 2 subscription when unloaded", async () => {
    const { plugin, commands } = loadInstalledPlugin();
    const events = new PassThrough({ objectMode: true });
    const closed = finished(events);
    const dispose = plugin.setup({
      event: { subscribe: ({ signal }) => addAbortSignal(signal, events) },
    });

    dispose();

    await expect(closed).rejects.toMatchObject({ name: "AbortError" });
    expect(commands).toEqual([]);
  });

  it("keeps both generations inert outside Paseo terminals", async () => {
    const { plugin, commands } = loadInstalledPlugin("");
    await plugin.server().event({
      event: { type: "session.status", properties: { status: { type: "busy" } } },
    });
    const events = Readable.from([
      { type: "session.execution.started", data: { sessionID: "session-1" } },
      { type: "permission.asked", data: { sessionID: "session-1" } },
    ]);
    const dispose = plugin.setup({ event: { subscribe: () => events } });
    await finished(events);
    dispose();

    expect(commands).toEqual([]);
  });

  it("uninstalls the OpenCode plugin file", () => {
    const configDir = createTempDir("paseo-opencode-config-uninstall-");
    const configPath = resolveAgentHookConfigPath(opencodeAgentHookProvider, { configDir });
    installAgentHooks(opencodeAgentHookProvider, { configDir });

    const result = uninstallAgentHooks(opencodeAgentHookProvider, { configDir });

    expect(result).toEqual({ configPath, changed: true });
    expect(existsSync(configPath)).toBe(false);
    expect(agentHooksAreInstalled(opencodeAgentHookProvider, { configDir })).toBe(false);
  });

  it("prefers OPENCODE_CONFIG_DIR over the XDG config home", () => {
    const homeDir = createTempDir("paseo-home-");
    const configDir = createTempDir("paseo-opencode-override-");
    const xdgConfigHome = createTempDir("paseo-xdg-config-");

    const configPath = resolveAgentHookConfigPath(opencodeAgentHookProvider, {
      env: { OPENCODE_CONFIG_DIR: configDir, XDG_CONFIG_HOME: xdgConfigHome },
      homeDir,
    });

    expect(configPath).toBe(join(configDir, "plugins", "paseo-terminal-activity.js"));
  });

  it("uses the XDG config home for the default OpenCode config dir", () => {
    const homeDir = createTempDir("paseo-home-");
    const xdgConfigHome = createTempDir("paseo-xdg-config-");

    const configPath = resolveAgentHookConfigPath(opencodeAgentHookProvider, {
      env: { XDG_CONFIG_HOME: xdgConfigHome },
      homeDir,
    });

    expect(configPath).toBe(
      join(xdgConfigHome, "opencode", "plugins", "paseo-terminal-activity.js"),
    );
  });

  it("falls back to the home .config OpenCode dir without an XDG config home", () => {
    const homeDir = createTempDir("paseo-home-");

    const configPath = resolveAgentHookConfigPath(opencodeAgentHookProvider, {
      env: {},
      homeDir,
    });

    expect(configPath).toBe(
      join(homeDir, ".config", "opencode", "plugins", "paseo-terminal-activity.js"),
    );
  });

  it.each([
    ["session.status.busy", "running"],
    ["session.status.retry", "running"],
    ["session.status.idle", "idle"],
    ["permission.asked", "needs-input"],
    ["permission.replied", "running"],
  ] as const)("maps %s to %s", async (event, state) => {
    await expect(
      opencodeAgentHookProvider.resolveActivity({
        event,
        input: { read: async () => null },
      }),
    ).resolves.toBe(state);
  });
});

interface OpenCodeEvent {
  type: string;
  properties?: { status: { type: string } };
  data?: { sessionID: string };
}

interface InstalledPlugin {
  id: string;
  server(): { event(input: { event: OpenCodeEvent }): Promise<void> };
  setup(context: {
    event: { subscribe(options: { signal: AbortSignal }): AsyncIterable<OpenCodeEvent> };
  }): () => void;
}

function loadInstalledPlugin(terminalId = "terminal-1", exited = Promise.resolve(0)) {
  const configDir = createTempDir("paseo-opencode-runtime-");
  const { configPath } = installAgentHooks(opencodeAgentHookProvider, { configDir });
  const source = readFileSync(configPath, "utf8");
  const commands: string[][] = [];
  // Supply the host runtime at the script boundary; execute the installed source.
  const plugin: InstalledPlugin = runInNewContext(
    source.replace("export default", "globalThis.plugin ="),
    {
      AbortController,
      process: { env: { PASEO_TERMINAL_ID: terminalId } },
      Bun: {
        spawn(command: string[]) {
          commands.push(command);
          return { exited };
        },
      },
    },
  );
  return { plugin, commands };
}
