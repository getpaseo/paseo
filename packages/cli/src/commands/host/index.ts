import { readFile } from "node:fs/promises";
import { Command } from "commander";
import type { HostSummary, HostUpdate } from "@getpaseo/client";
import { DaemonPermissionSchema } from "@getpaseo/protocol/messages";
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
  tokenFile?: string;
  permission?: string[];
}

async function readReverseToken(path: string): Promise<string> {
  const contents = await readFile(path, "utf8").catch(() => {
    throw {
      code: "INVALID_REVERSE_TOKEN",
      message: "Could not read the file supplied with --token-file.",
    };
  });
  const token = contents.replace(/\r?\n$/, "");
  if (!/^[a-f0-9]{64}$/.test(token))
    throw {
      code: "INVALID_REVERSE_TOKEN",
      message: "The reverse token file must contain 64 lowercase hexadecimal characters.",
    };
  return token;
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

async function runReverse(
  action: "accept" | "enable" | "disable",
  id: string,
  options: Options,
): Promise<CommandResult<HostSummary>> {
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    if (client.getLastServerInfoMessage()?.features?.hostBidirectionalLinks !== true)
      throw {
        code: "DAEMON_UPDATE_REQUIRED",
        message: "Update the host to manage bidirectional connections.",
      };
    if (action === "accept") {
      if (!/^[A-Za-z0-9_-]{1,256}$/.test(id))
        throw { code: "INVALID_SERVER_ID", message: "Supply the dialing daemon's server ID." };
      return {
        type: "single",
        data: await client.addHost({
          connection: `reverse://${id}`,
          incomingToken: await readReverseToken(options.tokenFile!),
          label: options.label,
        }),
        schema,
      };
    }
    let reverseOffer: HostUpdate["reverseOffer"] = null;
    if (action === "enable") {
      const permissions = DaemonPermissionSchema.array().nonempty().safeParse(options.permission);
      if (!permissions.success)
        throw {
          code: "INVALID_REVERSE_PERMISSION",
          message: `Use --permission with a daemon permission (${DaemonPermissionSchema.options.join(", ")}).`,
        };
      reverseOffer = {
        token: await readReverseToken(options.tokenFile!),
        permissions: [...new Set(permissions.data)],
      };
    }
    return { type: "single", data: await client.updateHost(id, { reverseOffer }), schema };
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
  addJsonAndDaemonHostOptions(
    host
      .command("enable-reverse")
      .description("Allow a saved host to open channels back through its existing connection")
      .argument("<registration-id>")
      .requiredOption("--token-file <path>", "Read the shared reverse token from a local file")
      .requiredOption(
        "--permission <permission>",
        "Grant a daemon permission (repeatable)",
        collectMultiple,
        [],
      ),
  ).action(
    withOutput((id: string, options: Options, _command: Command) =>
      runReverse("enable", id, options),
    ),
  );
  addJsonAndDaemonHostOptions(
    host
      .command("accept-reverse")
      .description("Approve discovery of a daemon that dials this host")
      .argument("<peer-server-id>")
      .requiredOption("--token-file <path>", "Read the shared reverse token from a local file")
      .option("--label <name>"),
  ).action(
    withOutput((id: string, options: Options, _command: Command) =>
      runReverse("accept", id, options),
    ),
  );
  addJsonAndDaemonHostOptions(
    host
      .command("disable-reverse")
      .description("Revoke reverse access on a saved host")
      .argument("<registration-id>"),
  ).action(
    withOutput((id: string, options: Options, _command: Command) =>
      runReverse("disable", id, options),
    ),
  );
  for (const action of ["inspect", "enable", "disable", "rm"])
    addJsonAndDaemonHostOptions(host.command(action).argument("<registration-id>")).action(
      withOutput((id: string, options: Options, _command: Command) => run(action, id, options)),
    );
  return host;
}
