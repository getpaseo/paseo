import type { Command } from "commander";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { connectToDaemon } from "../../utils/client.js";
import { withOutput, type CommandOptions, type OutputSchema } from "../../output/index.js";
import { addJsonAndDaemonHostOptions, collectMultiple } from "../../utils/command-options.js";

interface PluginConfigOptions extends CommandOptions {
  plugin?: string;
  expect?: string;
  select?: string[];
  receipt?: string[];
  yes?: boolean;
  operation?: "adopt" | "reset";
}

interface PluginConfigResult {
  agentId: string;
  pluginId: string;
  operation: string;
  details: string;
}

const schema: OutputSchema<PluginConfigResult> = {
  idField: "agentId",
  columns: [
    { header: "AGENT", field: "agentId" },
    { header: "PLUGIN", field: "pluginId" },
    { header: "OPERATION", field: "operation" },
    { header: "DETAILS", field: "details" },
  ],
};

type AdoptionClient = Pick<
  DaemonClient,
  "previewLegacyPluginConfig" | "applyLegacyPluginConfig" | "resetLegacyPluginConfig" | "close"
>;

export async function runPluginConfig(
  operation: "preview" | "apply" | "reset",
  agentId: string,
  options: PluginConfigOptions,
  connect: (
    options: Parameters<typeof connectToDaemon>[0],
  ) => Promise<AdoptionClient> = connectToDaemon,
) {
  const pluginId = options.plugin;
  if (!pluginId?.trim()) throw new Error("Provide --plugin <runtime-id>");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(agentId)) {
    throw new Error(
      "Use the exact agent UUID; plugin configuration does not resolve names or prefixes",
    );
  }
  if (operation !== "preview" && (!options.yes || !options.expect)) {
    throw new Error(
      "Preview first, then provide --expect <fingerprint> and --yes; no agent is reloaded automatically",
    );
  }
  const selections = (options.select ?? []).map((value) => {
    const separator = value.indexOf("=");
    return separator < 0
      ? { id: value }
      : { id: value.slice(0, separator), baselineId: value.slice(separator + 1) };
  });
  if (operation === "apply" && !selections.length)
    throw new Error("Select candidates explicitly with --select <id[=baseline-id]>");
  if (operation === "reset" && !options.receipt?.length)
    throw new Error("Select receipts explicitly with --receipt <id>");
  const client = await connect({ target: options.daemonTarget });
  try {
    let result: unknown;
    if (operation === "preview") {
      result = await client.previewLegacyPluginConfig(agentId, {
        pluginId,
        operation: options.operation ?? "adopt",
      });
    } else if (operation === "apply") {
      result = await client.applyLegacyPluginConfig(agentId, {
        pluginId,
        expectedFingerprint: options.expect!,
        selections,
      });
    } else {
      result = await client.resetLegacyPluginConfig(agentId, {
        pluginId,
        expectedFingerprint: options.expect!,
        receiptIds: options.receipt!,
      });
    }
    return {
      type: "single" as const,
      data: { agentId, pluginId, operation, details: JSON.stringify(result) },
      schema,
    };
  } finally {
    await client.close();
  }
}

export function addPluginConfigCommands(agent: Command): void {
  const parent = agent
    .command("plugin-config")
    .description("Preview and explicitly adopt or reset saved plugin configuration");
  addJsonAndDaemonHostOptions(
    parent
      .command("preview")
      .argument("<exact-agent-id>")
      .requiredOption("--plugin <runtime-id>", "Plugin runtime ID")
      .option("--operation <operation>", "adopt or reset", "adopt"),
  ).action(
    withOutput(async (id: string, options: PluginConfigOptions, _command: Command) => {
      if (options.operation !== "adopt" && options.operation !== "reset")
        throw new Error("Expected --operation adopt or reset");
      return runPluginConfig("preview", id, options);
    }),
  );
  addJsonAndDaemonHostOptions(
    parent
      .command("apply")
      .argument("<exact-agent-id>")
      .requiredOption("--plugin <runtime-id>", "Plugin runtime ID")
      .requiredOption("--expect <fingerprint>", "Fingerprint from a fresh preview")
      .option("--select <id[=baseline-id]>", "Explicit candidate and baseline", collectMultiple, [])
      .option("--yes", "Apply selected receipts without reopening the agent"),
  ).action(
    withOutput((id: string, options: PluginConfigOptions, _command: Command) =>
      runPluginConfig("apply", id, options),
    ),
  );
  addJsonAndDaemonHostOptions(
    parent
      .command("reset")
      .argument("<exact-agent-id>")
      .requiredOption("--plugin <runtime-id>", "Plugin runtime ID")
      .requiredOption("--expect <fingerprint>", "Fingerprint from a reset preview")
      .option("--receipt <id>", "Explicit receipt to reset", collectMultiple, [])
      .option("--yes", "Reset selected receipts without reopening the agent"),
  ).action(
    withOutput((id: string, options: PluginConfigOptions, _command: Command) =>
      runPluginConfig("reset", id, options),
    ),
  );
}
