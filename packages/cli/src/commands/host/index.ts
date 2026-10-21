import { Command } from "commander";
import type { HostSummary, HostUpdate } from "@getpaseo/client";
import {
  withOutput,
  type CommandOptions,
  type OutputSchema,
  type CommandResult,
} from "../../output/index.js";
import { addJsonAndDaemonHostOptions, collectMultiple } from "../../utils/command-options.js";
import { connectToDaemon } from "../../utils/client.js";

const schema: OutputSchema<HostSummary> = {
  idField: "registrationId",
  columns: [
    { header: "ID", field: "registrationId" },
    { header: "LABEL", field: "label" },
    { header: "SERVER", field: "serverId" },
    { header: "ENABLED", field: "enabled" },
    { header: "STATUS", field: "status" },
    { header: "SOURCE", field: (row) => `${row.source.id}/${row.source.key}` },
  ],
};
function metadata(values: string[] = []): Record<string, string> {
  return Object.fromEntries(
    values.map((entry) => {
      const split = entry.indexOf("=");
      if (split < 1) throw { code: "invalid_metadata", message: "Metadata must use key=value" };
      return [entry.slice(0, split), entry.slice(split + 1)];
    }),
  );
}
interface Options extends CommandOptions {
  label?: string;
  meta?: string[];
  removeMeta?: string[];
  connection?: string;
  replaceIdentity?: boolean;
}
async function run(
  action: string,
  id: string | undefined,
  options: Options,
): Promise<CommandResult<HostSummary>> {
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    if (action === "add")
      return {
        type: "single",
        data: await client.addHost({
          connection: id!,
          label: options.label,
          metadata: metadata(options.meta),
        }),
        schema,
      };
    if (action === "ls") return { type: "list", data: (await client.listHosts()).hosts, schema };
    const host = (await client.listHosts()).hosts.find((entry) => entry.registrationId === id);
    if (!host) throw { code: "host_unknown", message: `Unknown registration ${id}` };
    if (action === "inspect")
      return {
        type: "single",
        data: host,
        schema: { ...schema, renderHuman: () => JSON.stringify(host, null, 2) },
      };
    if (action === "rm") {
      await client.removeHost(id!);
      return { type: "single", data: host, schema };
    }
    const patch: HostUpdate = {};
    if (action === "enable" || action === "disable") patch.enabled = action === "enable";
    if (options.label !== undefined) patch.label = options.label || null;
    if (options.connection !== undefined) patch.connection = options.connection;
    if (options.replaceIdentity) patch.replaceIdentity = true;
    if (options.meta?.length || options.removeMeta?.length) {
      patch.metadata = { ...host.metadata, ...metadata(options.meta) };
      for (const key of options.removeMeta ?? []) delete patch.metadata[key];
    }
    return { type: "single", data: await client.updateHost(id!, patch), schema };
  } finally {
    await client.close();
  }
}
export function createHostCommand(): Command {
  const host = new Command("host").description("Manage hosts connected to the selected daemon");
  addJsonAndDaemonHostOptions(
    host.command("ls").description("List saved hosts, including disabled and failed entries"),
  ).action(withOutput((options: Options, _command: Command) => run("ls", undefined, options)));
  addJsonAndDaemonHostOptions(
    host
      .command("add")
      .argument("<connection>")
      .option("--label <name>")
      .option("--meta <key=value>", "Set metadata", collectMultiple, []),
  ).action(
    withOutput((connection: string, options: Options, _command: Command) =>
      run("add", connection, options),
    ),
  );
  addJsonAndDaemonHostOptions(
    host
      .command("update")
      .argument("<registration-id>")
      .option("--label <name>")
      .option("--connection <connection>")
      .option("--replace-identity", "Accept a new destination identity")
      .option("--meta <key=value>", "Replace supplied metadata keys", collectMultiple, [])
      .option("--remove-meta <key>", "Remove a metadata key", collectMultiple, []),
  ).action(
    withOutput((id: string, options: Options, _command: Command) => run("update", id, options)),
  );
  for (const action of ["inspect", "enable", "disable", "rm"])
    addJsonAndDaemonHostOptions(host.command(action).argument("<registration-id>")).action(
      withOutput((id: string, options: Options, _command: Command) => run(action, id, options)),
    );
  return host;
}
