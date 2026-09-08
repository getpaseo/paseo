import { Command } from "commander";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { HubHttpClient } from "./hub-client/index.js";
import { addHubConnectCommand } from "./connect.js";
import { PrivateHubCredentialStore, type HubCredentialStore } from "./credentials.js";
import {
  type HubDaemonConnection,
  productionHubDaemonConnection,
  withHubDaemon,
} from "./daemon-client.js";
import { addHubDeployCommand } from "./deploy.js";
import { addHubDisconnectCommand } from "./disconnect.js";
import { createCliLoginFlow, type CliLoginFlow } from "./login-flow.js";
import { addHubLoginCommand } from "./login.js";
import { addHubLogoutCommand, productionLogoutPrompt } from "./logout.js";
import { addHubProjectsCommand } from "./projects.js";
import { addHubExportCommand } from "./export.js";
import { processHubReporter, type HubReporter } from "./reporter.js";
import { hubStatusResult } from "./status-output.js";
import { addHubResolutionHelp } from "./help.js";
import { addHubInitCommand, continueHubGuidedSetup } from "./init.js";
import { addHubPermissionsCommand } from "./permissions.js";

interface HubCommandEnvironment {
  env: Readonly<Record<string, string | undefined>>;
  credentials: HubCredentialStore;
  hub: HubHttpClient;
  login: Pick<CliLoginFlow, "authorize">;
  daemon: HubDaemonConnection;
  isInteractive(): boolean;
  confirmDisconnect(origin: string): Promise<boolean>;
  reporter: HubReporter;
  cwd(): string;
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
    reporter: processHubReporter,
    cwd: () => process.cwd(),
    ...productionLogoutPrompt,
  };
}

export function createHubCommand(overrides: Partial<HubCommandEnvironment> = {}): Command {
  const environment = { ...productionEnvironment(), ...overrides };
  const hub = addHubResolutionHelp(new Command("hub").description("Manage Paseo Hub"));

  addHubLoginCommand(hub, {
    env: environment.env,
    credentials: environment.credentials,
    flow: environment.login,
    reporter: environment.reporter,
    isInteractive: environment.isInteractive,
    continueGuidedSetup: (origin) => continueHubGuidedSetup(origin, environment),
  });
  addHubInitCommand(hub, environment);
  addHubConnectCommand(hub, {
    env: environment.env,
    credentials: environment.credentials,
    hub: environment.hub,
    daemon: environment.daemon,
    reporter: environment.reporter,
  });
  addJsonAndDaemonHostOptions(hub.command("status")).action(
    withOutput(async (...args) => {
      const options = args.at(-2) as { host?: string };
      return withHubDaemon(environment.daemon, options.host, async (client) =>
        hubStatusResult((await client.getHubStatus()).status),
      );
    }),
  );
  addHubDisconnectCommand(hub, {
    daemon: environment.daemon,
    reporter: environment.reporter,
  });
  addHubPermissionsCommand(hub, {
    daemon: environment.daemon,
    reporter: environment.reporter,
  });
  addHubProjectsCommand(hub, {
    env: environment.env,
    credentials: environment.credentials,
    hub: environment.hub,
    reporter: environment.reporter,
  });
  addHubExportCommand(hub, {
    env: environment.env,
    credentials: environment.credentials,
    hub: environment.hub,
    reporter: environment.reporter,
    cwd: environment.cwd,
  });
  addHubDeployCommand(hub, {
    env: environment.env,
    credentials: environment.credentials,
    hub: environment.hub,
    reporter: environment.reporter,
    cwd: environment.cwd,
  });
  addHubLogoutCommand(hub, {
    credentials: environment.credentials,
    daemon: environment.daemon,
    isInteractive: environment.isInteractive,
    confirmDisconnect: environment.confirmDisconnect,
    reporter: environment.reporter,
  });
  return hub;
}
