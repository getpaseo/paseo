import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { CommandError } from "../../output/index.js";
import { connectToDaemon } from "../../utils/client.js";

export async function withPluginManagementClient<T>(
  host: string | undefined,
  run: (client: DaemonClient) => Promise<T>,
): Promise<T> {
  const client = await connectToDaemon({ host });
  // COMPAT(pluginManagement): added in v0.3.1, remove gate after 2027-08-14.
  if (client.getLastServerInfoMessage()?.features?.pluginManagement !== true) {
    await client.close().catch(() => undefined);
    throw {
      code: "DAEMON_UPDATE_REQUIRED",
      message: "Update the host to use plugin management.",
    } satisfies CommandError;
  }
  try {
    return await run(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}
