import { Command } from "commander";
import { hostname } from "node:os";
import { withOutput, type ListResult, type OutputSchema } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { connectToDaemon } from "../../utils/client.js";
import { createDeviceAuthorizationWorkflow } from "./device-authorization.js";

interface HubCommandClient {
  connectHub(url: string, token: string): Promise<{ status: HubStatus }>;
  getHubStatus(): Promise<{ status: HubStatus }>;
  disconnectHub(force: boolean): Promise<{ status: HubStatus; warning?: string }>;
  close(): Promise<void>;
}

interface HubStatus {
  state: string;
  daemonId: string | null;
  hubOrigin: string | null;
  scopes: string[];
  connectedAt: string | null;
  lastError: string | null;
}

interface HubCommandEnvironment {
  connect(host: string | undefined): Promise<HubCommandClient>;
  authorize(url: string, displayName: string): Promise<string>;
  displayName(): string;
}

const productionEnvironment: HubCommandEnvironment = {
  connect: (host) => connectToDaemon({ host }),
  authorize: (url, displayName) => createDeviceAuthorizationWorkflow().authorize(url, displayName),
  displayName: hostname,
};

interface HubRow {
  state: string;
  daemonId: string | null;
  hub: string | null;
  scopes: string;
  connectedAt: string | null;
  error: string | null;
  warning?: string;
}

const schema: OutputSchema<HubRow> = {
  idField: "state",
  columns: [
    { header: "STATE", field: "state" },
    { header: "HUB", field: "hub" },
    { header: "DAEMON", field: "daemonId" },
    { header: "SCOPES", field: "scopes" },
    { header: "CONNECTED", field: "connectedAt" },
    { header: "ERROR", field: "error" },
    { header: "WARNING", field: "warning" },
  ],
};

function result(
  status: {
    state: string;
    daemonId: string | null;
    hubOrigin: string | null;
    scopes: string[];
    connectedAt: string | null;
    lastError: string | null;
  },
  warning?: string,
): ListResult<HubRow> {
  return {
    type: "list",
    data: [
      {
        state: status.state,
        daemonId: status.daemonId,
        hub: status.hubOrigin,
        scopes: status.scopes.join(", "),
        connectedAt: status.connectedAt,
        error: status.lastError,
        warning,
      },
    ],
    schema,
  };
}

async function withClient<T>(
  environment: HubCommandEnvironment,
  host: string | undefined,
  action: (client: HubCommandClient) => Promise<T>,
): Promise<T> {
  const client = await environment.connect(host);
  try {
    return await action(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

export function createHubCommand(
  environment: HubCommandEnvironment = productionEnvironment,
): Command {
  const hub = new Command("hub").description("Manage this daemon's Paseo Hub relationship");
  addJsonAndDaemonHostOptions(
    hub.command("connect").argument("<url>").option("--token <token>"),
  ).action(
    withOutput(async (...args) => {
      const url = args[0] as string;
      const options = args.at(-2) as { token?: string; host?: string };
      return withClient(environment, options.host, async (client) => {
        if (options.token !== undefined) {
          return result((await client.connectHub(url, options.token)).status);
        }
        const existing = (await client.getHubStatus()).status;
        if (existing.state !== "not_connected" && existing.state !== "revoked") {
          throw new Error("This daemon already has a Hub relationship");
        }
        const token = await environment.authorize(
          url,
          suggestedDisplayName(environment.displayName()),
        );
        return result((await client.connectHub(url, token)).status);
      });
    }),
  );
  addJsonAndDaemonHostOptions(hub.command("status")).action(
    withOutput(async (...args) => {
      const options = args.at(-2) as { host?: string };
      return withClient(environment, options.host, async (client) =>
        result((await client.getHubStatus()).status),
      );
    }),
  );
  addJsonAndDaemonHostOptions(
    hub
      .command("disconnect")
      .option("--force", "Remove local authority even if the Hub is offline"),
  ).action(
    withOutput(async (...args) => {
      const options = args.at(-2) as { host?: string; force?: boolean };
      return withClient(environment, options.host, async (client) => {
        const response = await client.disconnectHub(options.force ?? false);
        return result(response.status, response.warning);
      });
    }),
  );
  return hub;
}

function suggestedDisplayName(value: string): string {
  return value.trim().slice(0, 100) || "Paseo daemon";
}
