import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { CommandError } from "../../output/index.js";
import { connectToDaemon } from "../../utils/client.js";

type PluginFeature = "pluginManagement" | "pluginLogs" | "pluginGitManagement";

async function withPluginClient<T>(
  host: string | undefined,
  feature: PluginFeature,
  updateMessage: string,
  run: (client: DaemonClient) => Promise<T>,
): Promise<T> {
  const client = await connectToDaemon({ host });
  if (client.getLastServerInfoMessage()?.features?.[feature] !== true) {
    await client.close().catch(() => undefined);
    throw {
      code: "DAEMON_UPDATE_REQUIRED",
      message: updateMessage,
    } satisfies CommandError;
  }
  try {
    return await run(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function withPluginManagementClient<T>(
  host: string | undefined,
  run: (client: DaemonClient) => Promise<T>,
): Promise<T> {
  // COMPAT(pluginManagement): added in v0.3.1, remove gate after 2027-08-14.
  return withPluginClient(
    host,
    "pluginManagement",
    "Update the host to use plugin management.",
    run,
  );
}

export async function withPluginLogsClient<T>(
  host: string | undefined,
  run: (client: DaemonClient) => Promise<T>,
): Promise<T> {
  // COMPAT(pluginLogs): added in v0.4.0, remove gate after 2027-08-16.
  return withPluginClient(host, "pluginLogs", "Update the host to view plugin logs.", run);
}

export async function withPluginSourceClient<T>(
  host: string | undefined,
  run: (client: DaemonClient) => Promise<T>,
): Promise<T> {
  // COMPAT(pluginGitManagement): added in v0.7.0, remove gate after 2027-08-26.
  return withPluginClient(
    host,
    "pluginGitManagement",
    "Update the host to install and update Git plugins.",
    run,
  );
}
