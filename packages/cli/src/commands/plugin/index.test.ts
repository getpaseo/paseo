import { beforeEach, describe, expect, it, vi } from "vitest";

const listPlugins = vi.fn(async () => [
  {
    id: "git-plugin",
    path: "/plugins/git-plugin",
    enabled: true,
    status: "running" as const,
    source: "git" as const,
    commit: "1557a34c91e2abcdef",
    ref: "main",
  },
  {
    id: "legacy-plugin",
    path: "/plugins/legacy-plugin",
    enabled: true,
    status: "failed" as const,
    error: "This plugin was made for an older version of Paseo",
  },
]);
const getPluginLogs = vi.fn(async () => [
  {
    sequence: 1,
    timestamp: "2026-08-16T12:00:00.000Z",
    stream: "stdout" as const,
    message: "ready",
  },
]);
const installDirectoryPlugin = vi.fn(async () => ({
  id: "trusted-plugin",
  path: "/plugins/trusted-plugin",
  enabled: true,
  status: "running" as const,
}));
const installPluginSource = vi.fn(async () => ({
  id: "trusted-plugin",
  path: "/plugins/trusted-plugin",
  enabled: true,
  status: "running" as const,
}));
const close = vi.fn(async () => undefined);
const features: {
  pluginManagement?: boolean;
  pluginLogs?: boolean;
  pluginGitManagement?: boolean;
} = {};

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(async () => ({
    getLastServerInfoMessage: () => ({ features }),
    listPlugins,
    getPluginLogs,
    installDirectoryPlugin,
    installPluginSource,
    close,
  })),
}));

import { render } from "../../output/index.js";
import { createPluginCommand, runPluginListCommand, runPluginLogsCommand } from "./index.js";

describe("plugin management commands", () => {
  beforeEach(() => {
    features.pluginManagement = false;
    features.pluginLogs = false;
    features.pluginGitManagement = false;
    vi.clearAllMocks();
  });

  it("requires host support before attempting a management RPC", async () => {
    await expect(runPluginListCommand(undefined, {}, {} as never)).rejects.toMatchObject({
      code: "DAEMON_UPDATE_REQUIRED",
      message: "Update the host to use plugin management.",
    });
    expect(listPlugins).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("keeps status as a hidden alias for the network-free plugin list", async () => {
    features.pluginManagement = true;
    const command = createPluginCommand();

    await command.parseAsync(["status"], { from: "user" });

    expect(listPlugins).toHaveBeenCalledTimes(1);
    expect(command.helpInformation()).not.toContain("status");
  });

  it("lists runtime state and the installed commit without an upstream commit", async () => {
    features.pluginManagement = true;

    const result = await runPluginListCommand(undefined, {}, {} as never);
    const output = render(result, { noColor: true });

    expect(output).toContain("SOURCE");
    expect(output).toContain("COMMIT");
    expect(output).not.toContain("LATEST");
    expect(output).toContain("1557a34c91e2");
    expect(output).toContain("This plugin was made for an older version of Paseo");
  });

  it("filters the shared ls and status command by plugin ID", async () => {
    features.pluginManagement = true;

    const result = await runPluginListCommand("legacy-plugin", {}, {} as never);

    expect(result.data.map((plugin) => plugin.id)).toEqual(["legacy-plugin"]);
  });

  it("requires plugin log support before attempting the RPC", async () => {
    await expect(runPluginLogsCommand("example", {}, {} as never)).rejects.toMatchObject({
      code: "DAEMON_UPDATE_REQUIRED",
      message: "Update the host to view plugin logs.",
    });
    expect(getPluginLogs).not.toHaveBeenCalled();
  });

  it("returns readable and JSON plugin log output", async () => {
    features.pluginLogs = true;
    const result = await runPluginLogsCommand("example", {}, {} as never);

    expect(getPluginLogs).toHaveBeenCalledWith("example");
    expect(render(result, { noColor: true })).toContain("ready");
    expect(JSON.parse(render(result, { format: "json" }))).toEqual([
      {
        sequence: 1,
        timestamp: "2026-08-16T12:00:00.000Z",
        stream: "stdout",
        message: "ready",
      },
    ]);
  });

  it("makes trust explicit at the plugin add entry point", () => {
    const command = createPluginCommand();
    expect(
      command.commands.find((subcommand) => subcommand.name() === "install")?.description(),
    ).toContain("Trust and install");
    expect(command.helpInformation()).toContain("trusted, unsandboxed plugins");
  });

  it("prints the trust acknowledgement before installing", async () => {
    features.pluginManagement = true;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const command = createPluginCommand();

    await command.parseAsync(["install", "/plugins/trusted-plugin"], { from: "user" });

    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("Git build commands run unsandboxed on the daemon host"),
    );
    expect(installDirectoryPlugin).toHaveBeenCalledWith("/plugins/trusted-plugin", undefined);
    stderr.mockRestore();
  });

  it("folds the legacy --path option into the plugin source reference", async () => {
    features.pluginGitManagement = true;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const command = createPluginCommand();

    await command.parseAsync(["install", "owner/monorepo", "--path", "plugins/review"], {
      from: "user",
    });

    expect(installPluginSource).toHaveBeenCalledWith({
      source: "owner/monorepo:plugins/review",
    });
    stderr.mockRestore();
  });

  it("keeps an absolute monorepo path as one plugin source reference", async () => {
    features.pluginGitManagement = true;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const command = createPluginCommand();

    await command.parseAsync(["install", "/plugins/monorepo:plugins/review"], { from: "user" });

    expect(installPluginSource).toHaveBeenCalledWith({
      source: "/plugins/monorepo:plugins/review",
    });
    expect(installDirectoryPlugin).not.toHaveBeenCalled();
    stderr.mockRestore();
  });
});
