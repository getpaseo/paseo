import { confirm, isCancel } from "@clack/prompts";
import type { Command } from "commander";
import { withOutput, type OutputSchema, type SingleResult } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import type { HubCredentialStore } from "./credentials.js";
import type { HubDaemonConnection, HubStatus } from "./daemon-client.js";
import { withHubDaemon } from "./daemon-client.js";

interface HubLogoutResult {
  origin: string | null;
  status: "logged_out" | "not_logged_in";
  daemonDisconnected: boolean;
}

const schema: OutputSchema<HubLogoutResult> = {
  idField: "status",
  columns: [
    { header: "HUB", field: "origin" },
    { header: "STATUS", field: "status" },
    { header: "DAEMON DISCONNECTED", field: "daemonDisconnected" },
  ],
};

interface HubLogoutOptions {
  disconnectDaemon?: boolean;
  force?: boolean;
  host?: string;
  json?: boolean;
}

interface HubLogoutDependencies {
  credentials: HubCredentialStore;
  daemon: HubDaemonConnection;
  isInteractive(): boolean;
  confirmDisconnect(origin: string): Promise<boolean>;
}

export async function runHubLogout(
  options: HubLogoutOptions,
  dependencies: HubLogoutDependencies,
): Promise<SingleResult<HubLogoutResult>> {
  const active = dependencies.credentials.active();
  if (active === null) {
    return logoutResult({ origin: null, status: "not_logged_in", daemonDisconnected: false });
  }

  const mayPrompt = options.json !== true && dependencies.isInteractive();
  let daemonStatus: HubStatus | null = null;
  if (options.disconnectDaemon === true) {
    daemonStatus = await withHubDaemon(dependencies.daemon, options.host, async (daemon) =>
      daemon.getHubStatus().then((response) => response.status),
    );
  } else if (mayPrompt) {
    daemonStatus = await withHubDaemon(dependencies.daemon, options.host, async (daemon) =>
      daemon.getHubStatus().then((response) => response.status),
    ).catch(() => null);
  }
  dependencies.credentials.logoutActive();

  const sameHub = daemonStatus?.hubOrigin === active.origin;
  let shouldDisconnect = options.disconnectDaemon === true && sameHub;
  if (options.disconnectDaemon !== true && mayPrompt && sameHub) {
    shouldDisconnect = await dependencies.confirmDisconnect(active.origin);
  }
  if (!shouldDisconnect) {
    return logoutResult({ origin: active.origin, status: "logged_out", daemonDisconnected: false });
  }
  await withHubDaemon(dependencies.daemon, options.host, async (daemon) => {
    await daemon.disconnectHub(options.force ?? false);
  });
  return logoutResult({ origin: active.origin, status: "logged_out", daemonDisconnected: true });
}

export function addHubLogoutCommand(parent: Command, dependencies: HubLogoutDependencies): void {
  addJsonAndDaemonHostOptions(
    parent
      .command("logout")
      .description("Remove the active stored Hub CLI login")
      .option("--disconnect-daemon", "Also disconnect a daemon related to the same Hub")
      .option("--force", "Remove daemon authority even if Hub is offline"),
  ).action(
    withOutput(async (...args) => {
      const options = args.at(-2) as HubLogoutOptions;
      return runHubLogout(options, dependencies);
    }),
  );
}

export const productionLogoutPrompt = {
  isInteractive: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
  async confirmDisconnect(origin: string): Promise<boolean> {
    const answer = await confirm({
      message: `Disconnect this daemon from ${origin}?`,
      initialValue: false,
    });
    return !isCancel(answer) && answer;
  },
};

function logoutResult(data: HubLogoutResult): SingleResult<HubLogoutResult> {
  return { type: "single", data, schema };
}
