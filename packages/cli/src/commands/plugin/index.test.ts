import { beforeEach, describe, expect, it, vi } from "vitest";

const daemonTarget = { kind: "endpoint" as const, host: "example.test:12345" };

const listPlugins = vi.fn(async () => [
  {
    id: "git-plugin",
    path: "/plugins/git-plugin",
    enabled: true,
    status: "running" as const,
    source: "git" as const,
    commit: "1557a34c91e2abcdef",
    ref: "main",
    installation: {
      identity: {
        kind: "git" as const,
        remote: "https://example.test/plugin.git",
        pluginPath: ".",
      },
      currentRevision: "1557a34c91e2abcdef",
    },
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
const installPluginSource = vi.fn(async () => ({
  id: "trusted-plugin",
  path: "/plugins/trusted-plugin",
  enabled: true,
  status: "running" as const,
}));
const installDirectoryPlugin = vi.fn(async () => ({
  id: "legacy-plugin",
  path: "/plugins/legacy-plugin",
  enabled: true,
  status: "running" as const,
}));
const previewPluginUpdates = vi.fn(async () => []);
const close = vi.fn(async () => undefined);
const features: {
  pluginManagement?: boolean;
  pluginLogs?: boolean;
  pluginGitManagement?: boolean;
  pluginSourceInstallation?: boolean;
  pluginSourceUpdates?: boolean;
} = {};

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(async () => ({
    getLastServerInfoMessage: () => ({ features }),
    listPlugins,
    getPluginLogs,
    installDirectoryPlugin,
    installPluginSource,
    previewPluginUpdates,
    close,
  })),
}));

import { render } from "../../output/index.js";
import {
  createPluginCommand,
  runPluginInstallCommand,
  runPluginUpdateCommand,
  runPluginListCommand,
  runPluginLogsCommand,
} from "./index.js";

describe("plugin management commands", () => {
  beforeEach(() => {
    features.pluginManagement = false;
    features.pluginLogs = false;
    features.pluginGitManagement = false;
    features.pluginSourceInstallation = false;
    features.pluginSourceUpdates = false;
    vi.clearAllMocks();
  });

  it("requires host support before attempting a management RPC", async () => {
    await expect(
      runPluginListCommand(undefined, { daemonTarget }, {} as never),
    ).rejects.toMatchObject({
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

    const result = await runPluginListCommand(undefined, { daemonTarget }, {} as never);
    const output = render(result, { noColor: true });

    expect(output).toContain("SOURCE");
    expect(output).toContain("REVISION");
    expect(output).not.toContain("LATEST");
    expect(output).toContain("1557a34c91e2");
    expect(output).toContain("This plugin was made for an older version of Paseo");
  });

  it("filters the shared ls and status command by plugin ID", async () => {
    features.pluginManagement = true;

    const result = await runPluginListCommand("legacy-plugin", { daemonTarget }, {} as never);

    expect(result.data.map((plugin) => plugin.id)).toEqual(["legacy-plugin"]);
  });

  it("requires plugin log support before attempting the RPC", async () => {
    await expect(
      runPluginLogsCommand("example", { daemonTarget }, {} as never),
    ).rejects.toMatchObject({
      code: "DAEMON_UPDATE_REQUIRED",
      message: "Update the host to view plugin logs.",
    });
    expect(getPluginLogs).not.toHaveBeenCalled();
  });

  it("returns readable and JSON plugin log output", async () => {
    features.pluginLogs = true;
    const result = await runPluginLogsCommand("example", { daemonTarget }, {} as never);

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
    features.pluginSourceInstallation = true;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const command = createPluginCommand();

    await command.parseAsync(["install", "/plugins/trusted-plugin"], { from: "user" });

    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("preparation commands run unsandboxed on the daemon host"),
    );
    expect(installPluginSource).toHaveBeenCalledWith({ source: "/plugins/trusted-plugin" });
    stderr.mockRestore();
  });

  it("requires source support for directory installs without using the legacy RPC", async () => {
    features.pluginManagement = true;
    features.pluginGitManagement = true;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(
      runPluginInstallCommand("/plugins/trusted-plugin", { daemonTarget }, {} as never),
    ).rejects.toMatchObject({
      code: "DAEMON_UPDATE_REQUIRED",
      message: "Update the host to install plugin sources.",
    });
    expect(installPluginSource).not.toHaveBeenCalled();
    expect(installDirectoryPlugin).not.toHaveBeenCalled();
    stderr.mockRestore();
  });

  it.each([undefined, false, true])(
    "installs with source support and Git support=%s",
    async (gitSupport) => {
      features.pluginSourceInstallation = true;
      features.pluginGitManagement = gitSupport;
      await runPluginInstallCommand("npm:@acme/review@^1.0.0", { daemonTarget }, {} as never);
      expect(installPluginSource).toHaveBeenCalledWith({ source: "npm:@acme/review@^1.0.0" });
      expect(close).toHaveBeenCalledTimes(1);
    },
  );

  it.each([undefined, false])(
    "rejects installs before an RPC when source support=%s despite Git support",
    async (sourceSupport) => {
      features.pluginGitManagement = true;
      features.pluginSourceInstallation = sourceSupport;
      await expect(
        runPluginInstallCommand("owner/review", { daemonTarget }, {} as never),
      ).rejects.toMatchObject({
        code: "DAEMON_UPDATE_REQUIRED",
        message: "Update the host to install plugin sources.",
      });
      expect(installPluginSource).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledTimes(1);
    },
  );

  it.each([undefined, false, true])(
    "reviews updates with source install support=%s",
    async (sourceSupport) => {
      features.pluginSourceUpdates = true;
      features.pluginSourceInstallation = sourceSupport;
      await runPluginUpdateCommand("review", { daemonTarget }, {} as never);
      expect(previewPluginUpdates).toHaveBeenCalledWith({ pluginId: "review", target: undefined });
      expect(close).toHaveBeenCalledTimes(1);
    },
  );

  it.each([undefined, false])(
    "rejects reviewed updates when support=%s despite legacy Git support",
    async (gitSupport) => {
      features.pluginSourceInstallation = true;
      features.pluginGitManagement = true;
      features.pluginSourceUpdates = gitSupport;
      await expect(
        runPluginUpdateCommand("review", { daemonTarget }, {} as never),
      ).rejects.toMatchObject({
        code: "DAEMON_UPDATE_REQUIRED",
        message: "Update the host to review plugin updates.",
      });
      expect(previewPluginUpdates).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledTimes(1);
    },
  );

  it("folds the legacy --path option into the plugin source reference", async () => {
    features.pluginSourceInstallation = true;
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
    features.pluginSourceInstallation = true;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const command = createPluginCommand();

    await command.parseAsync(["install", "/plugins/monorepo:plugins/review"], { from: "user" });

    expect(installPluginSource).toHaveBeenCalledWith({
      source: "/plugins/monorepo:plugins/review",
    });
    stderr.mockRestore();
  });
});

import { reviewPluginUpdates, type UpdateInteraction } from "./update.js";
import type {
  PluginUpdatePreview,
  PluginUpdateProposal,
  PluginUpdateResult,
} from "@getpaseo/protocol/messages";
function reviewFixture(answer = true, outcome: "update" | "installed-newer" = "update") {
  const proposal: PluginUpdateProposal = {
    id: "review",
    expected: {
      identity: { kind: "npm", packageName: "review", pluginPath: "." },
      installationRoot: "/owned/one",
      revision: "1.0.0",
    },
    target: {
      kind: "npm",
      version: "1.1.0",
      resolved: "https://registry.npmjs.org/review.tgz",
      integrity: "sha512-test",
    },
  };
  const preview: PluginUpdatePreview = {
    id: "review",
    outcome,
    links: ["https://npmjs.com/package/review/v/1.1.0"],
    current: { identity: proposal.expected.identity, currentRevision: "1.0.0" },
    target: proposal.target,
    ...(outcome === "update" ? { proposal } : {}),
  };
  const applied: PluginUpdateProposal[][] = [];
  const questions: string[] = [];
  const output: string[] = [];
  const client = {
    previewPluginUpdates: async () => [preview],
    applyPluginUpdates: async (
      proposals: PluginUpdateProposal[],
    ): Promise<PluginUpdateResult[]> => {
      applied.push(proposals);
      return [{ id: "review", outcome: "updated" }];
    },
  };
  const interaction: UpdateInteraction = {
    interactive: true,
    structured: false,
    write: (text) => {
      output.push(text);
    },
    confirm: async (question) => {
      questions.push(question);
      return answer;
    },
  };
  return { client, interaction, proposal, applied, questions, output };
}
describe("reviewed plugin update workflow", () => {
  it("prints target and links, then declines without applying", async () => {
    const f = reviewFixture(false);
    expect(await reviewPluginUpdates(f.client, { pluginId: "review" }, f.interaction)).toEqual([
      { id: "review", outcome: "declined" },
    ]);
    expect(f.output.join("")).toContain("1.0.0 → 1.1.0");
    expect(f.output.join("")).toContain("Review: https://");
    expect(f.questions).toEqual(["Update review? [y/N] "]);
    expect(f.applied).toEqual([]);
  });
  it("applies exactly the displayed proposal after approval", async () => {
    const f = reviewFixture();
    await reviewPluginUpdates(f.client, { pluginId: "review" }, f.interaction);
    expect(f.applied).toEqual([[f.proposal]]);
  });
  it.each([{ yes: true }, { version: "stable" }, { ref: "v1" }])(
    "skips questions for %j",
    async (options) => {
      const f = reviewFixture();
      await reviewPluginUpdates(f.client, { pluginId: "review", ...options }, f.interaction);
      expect(f.questions).toEqual([]);
      expect(f.applied).toEqual([[f.proposal]]);
    },
  );
  it("check takes precedence over yes and explicit targets", async () => {
    const f = reviewFixture();
    await reviewPluginUpdates(
      f.client,
      { pluginId: "review", check: true, yes: true, version: "1.1.0" },
      f.interaction,
    );
    expect(f.applied).toEqual([]);
    expect(f.questions).toEqual([]);
  });
  it("yes never applies an ordinary downgrade", async () => {
    const f = reviewFixture(true, "installed-newer");
    await reviewPluginUpdates(f.client, { all: true, yes: true }, f.interaction);
    expect(f.applied).toEqual([]);
    expect(f.questions).toEqual([]);
  });
  it.each([{ interactive: false }, { structured: true }])(
    "requires explicit approval for %j",
    async (flags) => {
      const f = reviewFixture();
      await expect(
        reviewPluginUpdates(f.client, { pluginId: "review" }, { ...f.interaction, ...flags }),
      ).rejects.toThrow("Confirmation required");
      expect(f.applied).toEqual([]);
    },
  );
});
