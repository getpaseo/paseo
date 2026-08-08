import type { Command } from "commander";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { resolveHubAuthority } from "./authority.js";
import type { HubHttpClient } from "./client.js";
import type { HubCredentialStore } from "./credentials.js";
import type { HubDaemonConnection } from "./daemon-client.js";
import { withHubDaemon } from "./daemon-client.js";
import { hubStatusResult } from "./status-output.js";

interface HubConnectOptions {
  apiKey?: string;
  host?: string;
}

interface HubConnectDependencies {
  env: Readonly<Record<string, string | undefined>>;
  credentials: HubCredentialStore;
  hub: Pick<HubHttpClient, "issueEnrollmentToken">;
  daemon: HubDaemonConnection;
}

export async function runHubConnect(
  origin: string,
  options: HubConnectOptions,
  dependencies: HubConnectDependencies,
) {
  const authority = resolveHubAuthority({
    options: { origin, apiKey: options.apiKey },
    env: dependencies.env,
    credentials: dependencies.credentials,
  });
  const token = await dependencies.hub.issueEnrollmentToken(authority.origin, authority.credential);
  return withHubDaemon(dependencies.daemon, options.host, async (daemon) => {
    const response = await daemon.connectHub(authority.origin, token);
    return hubStatusResult(response.status);
  });
}

export function addHubConnectCommand(parent: Command, dependencies: HubConnectDependencies): void {
  addJsonAndDaemonHostOptions(
    parent
      .command("connect")
      .description("Enroll this daemon with a Paseo Hub")
      .argument("<origin>")
      .option("--api-key <secret>", "Organization API key"),
  ).action(
    withOutput(async (...args) => {
      const origin = args[0] as string;
      const options = args.at(-2) as HubConnectOptions;
      return runHubConnect(origin, options, dependencies);
    }),
  );
}
