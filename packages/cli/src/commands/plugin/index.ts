import { createInterface } from "node:readline/promises";
import { reviewPluginUpdates, type UpdateOutcome } from "./update.js";
import { Command } from "commander";
import type { PluginListItem, PluginLogEntry } from "@getpaseo/protocol/messages";
import {
  formatPluginSourceReference,
  formatPluginIdentity,
} from "@getpaseo/protocol/plugin-source-reference";
import type { CommandOptions, ListResult, OutputSchema, SingleResult } from "../../output/index.js";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions, addJsonOption } from "../../utils/command-options.js";
import { scaffoldPluginDirectory, type PluginScaffold } from "./scaffold.js";
import {
  withPluginLogsClient,
  withPluginUpdateClient,
  withPluginManagementClient,
  withPluginSourceClient,
} from "./shared.js";

interface PluginOptions extends CommandOptions {
  host?: string;
  id?: string;
  ref?: string;
  path?: string;
  all?: boolean;
  version?: string;
  check?: boolean;
  yes?: boolean;
}

const pluginSchema: OutputSchema<PluginListItem> = {
  idField: "id",
  columns: [
    { header: "PLUGIN", field: "id", width: 20 },
    { header: "STATUS", field: "status", width: 10 },
    { header: "ENABLED", field: (plugin) => (plugin.enabled ? "yes" : "no"), width: 8 },
    {
      header: "SOURCE",
      field: (plugin) =>
        plugin.installation ? formatPluginIdentity(plugin.installation.identity) : "-",
      width: 40,
    },
    {
      header: "REVISION",
      field: (plugin) => plugin.installation?.currentRevision ?? "-",
      width: 16,
    },
    { header: "DIRECTORY", field: "path", width: 40 },
    { header: "ERROR", field: (plugin) => plugin.error ?? "", width: 40 },
  ],
};

const scaffoldSchema: OutputSchema<PluginScaffold> = {
  idField: "id",
  columns: [
    { header: "PLUGIN", field: "id", width: 20 },
    { header: "DIRECTORY", field: "directory", width: 60 },
  ],
};

const pluginLogsSchema: OutputSchema<PluginLogEntry> = {
  idField: (entry) => String(entry.sequence),
  columns: [
    { header: "TIME", field: "timestamp", width: 24 },
    { header: "STREAM", field: "stream", width: 8 },
    { header: "MESSAGE", field: "message", width: 80 },
  ],
};

const pluginUpdateSchema: OutputSchema<UpdateOutcome> = {
  idField: "id",
  columns: [
    { header: "PLUGIN", field: "id", width: 24 },
    { header: "RESULT", field: "outcome", width: 18 },
    {
      header: "DETAIL",
      field: (item) =>
        item.error ?? item.warning ?? item.plugin?.installation?.currentRevision ?? "",
      width: 50,
    },
  ],
};

export async function runPluginInitCommand(
  directory: string,
  options: PluginOptions,
  _command: Command,
): Promise<SingleResult<PluginScaffold>> {
  return {
    type: "single",
    data: await scaffoldPluginDirectory(directory, options.id),
    schema: scaffoldSchema,
  };
}

export async function runPluginListCommand(
  pluginId: string | undefined,
  options: PluginOptions,
  _command: Command,
): Promise<ListResult<PluginListItem>> {
  const plugins = await withPluginManagementClient(options.daemonTarget, (client) =>
    client.listPlugins(),
  );
  const data = pluginId ? plugins.filter((plugin) => plugin.id === pluginId) : plugins;
  if (pluginId && data.length === 0) throw new Error(`Plugin is not configured: ${pluginId}`);
  return { type: "list", data, schema: pluginSchema };
}

export async function runPluginLogsCommand(
  pluginId: string,
  options: PluginOptions,
  _command: Command,
): Promise<ListResult<PluginLogEntry>> {
  const data = await withPluginLogsClient(options.daemonTarget, (client) =>
    client.getPluginLogs(pluginId),
  );
  return { type: "list", data, schema: pluginLogsSchema };
}

export async function runPluginInstallCommand(
  source: string,
  options: PluginOptions,
  _command: Command,
): Promise<SingleResult<PluginListItem>> {
  process.stderr.write(
    "Trusting plugin code: server code and preparation commands run unsandboxed on the daemon host; client code runs inside Paseo. Dependencies and future updates are part of the codebase you trust.\n",
  );
  const sourceReference = formatPluginSourceReference(source, options.path);
  const data = await withPluginSourceClient(options.daemonTarget, (client) =>
    client.installPluginSource({
      source: sourceReference,
      ...(options.id ? { id: options.id } : {}),
      ...(options.ref ? { ref: options.ref } : {}),
    }),
  );
  return { type: "single", data, schema: pluginSchema };
}

export async function runPluginUpdateCommand(
  pluginId: string | undefined,
  options: PluginOptions,
  _command: Command,
): Promise<ListResult<UpdateOutcome>> {
  const data = await withPluginUpdateClient(options.daemonTarget, (client) =>
    reviewPluginUpdates(
      client,
      { ...options, pluginId },
      {
        interactive: process.stdin.isTTY === true,
        structured:
          options.json === true ||
          ["json", "yaml"].includes(options.format?.trim().toLowerCase() ?? ""),
        write: (text) => process.stderr.write(text),
        confirm: async (message) => {
          const prompt = createInterface({ input: process.stdin, output: process.stderr });
          try {
            return /^(y|yes)$/i.test((await prompt.question(message)).trim());
          } catch {
            return false;
          } finally {
            prompt.close();
          }
        },
      },
    ),
  );
  if (data.some((item) => item.outcome === "error")) process.exitCode = 1;
  return { type: "list", data, schema: pluginUpdateSchema };
}

async function act(
  action: "reload" | "enable" | "disable",
  pluginId: string,
  options: PluginOptions,
): Promise<SingleResult<PluginListItem>> {
  const data = await withPluginManagementClient(options.daemonTarget, (client) =>
    client[`${action}Plugin`](pluginId),
  );
  return { type: "single", data, schema: pluginSchema };
}

async function remove(
  pluginId: string,
  options: PluginOptions,
  _command: Command,
): Promise<SingleResult<PluginListItem>> {
  const data = await withPluginManagementClient(options.daemonTarget, async (client) => {
    const current = (await client.listPlugins()).find((plugin) => plugin.id === pluginId);
    if (!current) throw new Error(`Plugin is not configured: ${pluginId}`);
    await client.removePlugin(pluginId);
    return { ...current, enabled: false, status: "disabled" as const };
  });
  return { type: "single", data, schema: pluginSchema };
}

export function createPluginCommand(): Command {
  const plugin = new Command("plugin").description("Manage trusted, unsandboxed plugins");
  addJsonOption(
    plugin
      .command("init")
      .description("Create a typecheckable local plugin")
      .argument("<directory>")
      .option("--id <id>", "Manifest plugin ID (defaults to the directory name)"),
  ).action(withOutput(runPluginInitCommand));
  addJsonAndDaemonHostOptions(
    plugin.command("ls").description("List configured plugins").argument("[id]"),
  ).action(withOutput(runPluginListCommand));
  addJsonAndDaemonHostOptions(plugin.command("status", { hidden: true }).argument("[id]")).action(
    withOutput(runPluginListCommand),
  );
  addJsonAndDaemonHostOptions(
    plugin.command("logs").description("Show recent plugin output").argument("<id>"),
  ).action(withOutput(runPluginLogsCommand));
  addJsonAndDaemonHostOptions(
    plugin
      .command("install")
      .alias("add")
      .description("Trust and install a plugin from a directory, Git repository, or npm package")
      .argument(
        "<source>",
        "Host directory, Git or npm source, optionally followed by :plugin/path",
      )
      .option("--id <id>", "Runtime plugin ID (defaults to paseo-plugin.json id)")
      .option("--ref <ref>", "Git branch, tag, or commit")
      .option("--path <path>", "Legacy form of the :plugin/path source suffix"),
  ).action(withOutput(runPluginInstallCommand));
  addJsonAndDaemonHostOptions(
    plugin
      .command("update")
      .description("Review and update installed plugins")
      .argument("[id]")
      .option("--all", "Review all configured plugins")
      .option("--check", "Show available updates without installing")
      .option("--yes", "Apply displayed updates without asking")
      .option("--ref <ref>", "Apply a Git branch, tag, or commit without asking")
      .option("--version <version>", "Apply an npm version, tag, or range without asking"),
  ).action(withOutput(runPluginUpdateCommand));
  for (const action of ["reload", "enable", "disable"] as const) {
    addJsonAndDaemonHostOptions(
      plugin.command(action).description(`${action} a plugin`).argument("<id>"),
    ).action(
      withOutput((id: string, options: PluginOptions, _command: Command) =>
        act(action, id, options),
      ),
    );
  }
  addJsonAndDaemonHostOptions(
    plugin.command("remove").description("Remove plugin configuration").argument("<id>"),
  ).action(withOutput(remove));
  return plugin;
}
