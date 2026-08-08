import { Command } from "commander";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { HubHttpClient } from "./client.js";
import { addHubConnectCommand } from "./connect.js";
import { PrivateHubCredentialStore, type HubCredentialStore } from "./credentials.js";
import {
  type HubDaemonConnection,
  productionHubDaemonConnection,
  withHubDaemon,
} from "./daemon-client.js";
import { addHubDeployCommand } from "./deploy.js";
import { createCliLoginFlow, type CliLoginFlow } from "./login-flow.js";
import { addHubLoginCommand } from "./login.js";
import { addHubLogoutCommand, productionLogoutPrompt } from "./logout.js";
import { addHubProjectsCommand } from "./projects.js";
import { hubStatusResult } from "./status-output.js";

interface HubCommandEnvironment {
  env: Readonly<Record<string, string | undefined>>;
  credentials: HubCredentialStore;
  hub: HubHttpClient;
  login: Pick<CliLoginFlow, "authorize">;
  daemon: HubDaemonConnection;
  isInteractive(): boolean;
  confirmDisconnect(origin: string): Promise<boolean>;
}

function productionEnvironment(): HubCommandEnvironment {
  const env = process.env;
  const hub = new HubHttpClient();
  return {
    env,
    credentials: new PrivateHubCredentialStore(env),
    hub,
    login: createCliLoginFlow(hub),
    daemon: productionHubDaemonConnection,
    ...productionLogoutPrompt,
  };
}

export function createHubCommand(overrides: Partial<HubCommandEnvironment> = {}): Command {
  const environment = { ...productionEnvironment(), ...overrides };
  const hub = new Command("hub").description("Manage Paseo Hub");

  addHubLoginCommand(hub, {
    credentials: environment.credentials,
    flow: environment.login,
  });
  addHubConnectCommand(hub, {
    env: environment.env,
    credentials: environment.credentials,
    hub: environment.hub,
    daemon: environment.daemon,
  });
  addJsonAndDaemonHostOptions(hub.command("status")).action(
    withOutput(async (...args) => {
      const options = args.at(-2) as { host?: string };
      return withHubDaemon(environment.daemon, options.host, async (client) =>
        hubStatusResult((await client.getHubStatus()).status),
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
      return withHubDaemon(environment.daemon, options.host, async (client) => {
        const response = await client.disconnectHub(options.force ?? false);
        return hubStatusResult(response.status, response.warning);
      });
    }),
  );
  addHubProjectsCommand(hub, {
    env: environment.env,
    credentials: environment.credentials,
    hub: environment.hub,
  });
  addHubDeployCommand(hub);
  addHubLogoutCommand(hub, {
    credentials: environment.credentials,
    daemon: environment.daemon,
    isInteractive: environment.isInteractive,
    confirmDisconnect: environment.confirmDisconnect,
  });
  return hub;
}
