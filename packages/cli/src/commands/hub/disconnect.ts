import type { Command } from "commander";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import type { HubDaemonConnection } from "./daemon-client.js";
import { withHubDaemon } from "./daemon-client.js";
import { reportHubProgress, type HubReporter } from "./reporter.js";
import { hubStatusResult } from "./status-output.js";

interface HubDisconnectOptions {
  force?: boolean;
  host?: string;
  json?: boolean;
}

interface HubDisconnectDependencies {
  daemon: HubDaemonConnection;
  reporter: HubReporter;
}

export function runHubDisconnect(
  options: HubDisconnectOptions,
  dependencies: HubDisconnectDependencies,
) {
  return withHubDaemon(dependencies.daemon, options.host, async (client) => {
    const current = (await client.getHubStatus()).status;
    if (current.hubOrigin !== null) {
      reportHubProgress(
        dependencies.reporter,
        options,
        `Disconnecting this daemon from ${current.hubOrigin}`,
      );
    }
    const response = await client.disconnectHub(options.force ?? false);
    return hubStatusResult(response.status, response.warning, current.hubOrigin);
  });
}

export function addHubDisconnectCommand(
  parent: Command,
  dependencies: HubDisconnectDependencies,
): void {
  addJsonAndDaemonHostOptions(
    parent
      .command("disconnect")
      .option("--force", "Remove local authority even if the Hub is offline"),
  ).action(
    withOutput(async (...args) => {
      const options = args.at(-2) as HubDisconnectOptions;
      return runHubDisconnect(options, dependencies);
    }),
  );
}
