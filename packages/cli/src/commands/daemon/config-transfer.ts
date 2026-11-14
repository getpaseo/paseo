import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import {
  HostConfigDocumentSchema,
  type DaemonConfigImportApplyResponse,
  type DaemonConfigImportPreviewResponse,
  type HostConfigDocument,
} from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  CommandError,
  CommandOptions,
  OutputSchema,
  SingleResult,
} from "../../output/index.js";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { connectToDaemon } from "../../utils/client.js";

type ImportPreview = DaemonConfigImportPreviewResponse["payload"];
type ImportOutcome = Omit<DaemonConfigImportApplyResponse["payload"], "requestId">;
type TransferClient = Pick<
  DaemonClient,
  "exportConfig" | "previewConfigImport" | "applyConfigImport" | "getLastServerInfoMessage"
>;

export interface ExportSummary {
  file: string;
  sections: string[];
  plugins: string[];
  manualPlugins: string[];
  leftBehind: string[];
}

export interface ImportInteraction {
  interactive: boolean;
  structured: boolean;
  write(text: string): void;
  confirm(message: string): Promise<boolean>;
}

export function requireConfigTransfer(client: Pick<DaemonClient, "getLastServerInfoMessage">) {
  // COMPAT(configTransfer): added in v0.14.0, remove gate after 2027-04-28.
  if (client.getLastServerInfoMessage()?.features?.configTransfer !== true) {
    throw {
      code: "DAEMON_UPDATE_REQUIRED",
      message: "Update the host to export or import its configuration.",
    } satisfies CommandError;
  }
}

export async function exportHostConfig(
  client: TransferClient,
  file: string,
  write: (file: string, contents: string) => Promise<void>,
): Promise<ExportSummary> {
  requireConfigTransfer(client);
  const { document } = await client.exportConfig();
  await write(file, `${JSON.stringify(document, null, 2)}\n`);
  return {
    file,
    sections: Object.keys(document.config),
    plugins: document.plugins.map((plugin) => plugin.id),
    manualPlugins: document.manualPlugins.map((plugin) => plugin.id),
    leftBehind: document.redacted.map((entry) => entry.path),
  };
}

export function parseHostConfigFile(file: string, contents: string): HostConfigDocument {
  let json: unknown;
  try {
    json = JSON.parse(contents);
  } catch (error) {
    throw new Error(`${file} is not JSON: ${error instanceof Error ? error.message : error}`, {
      cause: error,
    });
  }
  const parsed = HostConfigDocumentSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`${file} is not a Paseo host config export (format "paseo-host-config")`);
  }
  return parsed.data;
}

function describeSection(section: ImportPreview["sections"][number]): string {
  if (section.status === "invalid") return `invalid, not applied: ${section.issues.join("; ")}`;
  if (section.status === "unchanged") return "unchanged";
  return `replaces ${section.changes.join(", ")}`;
}

export function formatImportPreview(preview: ImportPreview, enablePlugins: boolean): string {
  const lines = ["Sections:"];
  for (const section of preview.sections) {
    lines.push(`  ${section.id}: ${describeSection(section)}`);
  }
  lines.push("Plugins:");
  for (const plugin of preview.plugins) {
    lines.push(
      plugin.status === "install"
        ? `  ${plugin.id}: install from ${plugin.source}`
        : `  ${plugin.id}: ${plugin.status}${plugin.reason ? ` (${plugin.reason})` : ""}`,
    );
  }
  if (preview.requiresPluginsEnabled) {
    lines.push(
      enablePlugins
        ? `Plugins will be turned on for this host${preview.pluginsStartedByEnabling.length > 0 ? `, which also starts: ${preview.pluginsStartedByEnabling.join(", ")}` : ""}.`
        : "Plugins are turned off on this host; pass --enable-plugins to install them.",
    );
  }
  return `${lines.join("\n")}\n`;
}

export async function importHostConfig(
  client: TransferClient,
  document: HostConfigDocument,
  options: { yes: boolean; enablePlugins: boolean },
  interaction: ImportInteraction,
): Promise<ImportOutcome> {
  requireConfigTransfer(client);
  const preview = await client.previewConfigImport(document);
  if (!interaction.structured)
    interaction.write(formatImportPreview(preview, options.enablePlugins));
  if (!options.yes) {
    if (interaction.structured || !interaction.interactive)
      throw new Error("Confirmation required; rerun with --yes.");
    if (!(await interaction.confirm("Apply this import? [y/N] ")))
      return { results: [], reenter: [] };
  }
  return client.applyConfigImport({
    document,
    sections: preview.sections
      .filter((section) => section.status === "ready")
      .map((section) => section.id),
    plugins: preview.plugins
      .filter((plugin) => plugin.status === "install")
      .map((plugin) => plugin.id),
    enablePlugins: options.enablePlugins,
  });
}

export const exportSummarySchema: OutputSchema<ExportSummary> = {
  idField: () => "config-export",
  columns: [],
  renderHuman(result) {
    if (result.type !== "single") return "";
    const { data } = result;
    const lines = [`Exported to ${data.file}.`, `Sections: ${data.sections.join(", ") || "none"}`];
    lines.push(`Plugins: ${data.plugins.join(", ") || "none"}`);
    if (data.manualPlugins.length > 0)
      lines.push(`Not portable, reinstall by hand: ${data.manualPlugins.join(", ")}`);
    if (data.leftBehind.length > 0)
      lines.push(
        "Left behind (re-enter on the other host):",
        ...data.leftBehind.map((p) => `  ${p}`),
      );
    return lines.join("\n");
  },
};

export const importOutcomeSchema: OutputSchema<ImportOutcome> = {
  idField: () => "config-import",
  columns: [],
  renderHuman(result) {
    if (result.type !== "single") return "";
    const { results, reenter } = result.data;
    if (results.length === 0) return "Nothing applied.";
    const lines = results.map(
      (item) => `${item.outcome.padEnd(7)} ${item.item}${item.reason ? `: ${item.reason}` : ""}`,
    );
    if (reenter.length > 0)
      lines.push("", "Re-enter on this host:", ...reenter.map((entry) => `  ${entry.path}`));
    return lines.join("\n");
  },
};

interface ImportOptions extends CommandOptions {
  yes?: boolean;
  enablePlugins?: boolean;
}

async function withTransferClient<T>(
  options: CommandOptions,
  run: (client: DaemonClient) => Promise<T>,
): Promise<T> {
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    return await run(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

export function addConfigTransferCommands(config: Command): void {
  addJsonAndDaemonHostOptions(
    config
      .command("export <file>")
      .description("Write this host's portable configuration to a file; secrets stay behind"),
  ).action(
    withOutput(
      async (
        file: string,
        options: CommandOptions,
        _command: Command,
      ): Promise<SingleResult<ExportSummary>> => ({
        type: "single",
        data: await withTransferClient(options, (client) =>
          exportHostConfig(client, file, (target, contents) => writeFile(target, contents)),
        ),
        schema: exportSummarySchema,
      }),
    ),
  );
  addJsonAndDaemonHostOptions(
    config
      .command("import <file>")
      .description("Preview and apply a configuration exported from another host")
      .option("--yes", "Apply the displayed import without asking")
      .option("--enable-plugins", "Turn on plugins for this host so exported plugins can install"),
  ).action(
    withOutput(
      async (
        file: string,
        options: ImportOptions,
        _command: Command,
      ): Promise<SingleResult<ImportOutcome>> => {
        const document = parseHostConfigFile(file, await readFile(file, "utf8"));
        const data = await withTransferClient(options, (client) =>
          importHostConfig(
            client,
            document,
            { yes: options.yes === true, enablePlugins: options.enablePlugins === true },
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
                } finally {
                  prompt.close();
                }
              },
            },
          ),
        );
        if (data.results.some((item) => item.outcome === "failed")) process.exitCode = 1;
        return { type: "single", data, schema: importOutcomeSchema };
      },
    ),
  );
}
