import path from "node:path";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { connectDaemonClient } from "./daemon-client-loader";

type ControlledStreamClient = Pick<
  DaemonClient,
  | "connect"
  | "close"
  | "getDaemonConfig"
  | "patchDaemonConfig"
  | "installDirectoryPlugin"
  | "removePlugin"
  | "invokePluginRpc"
>;

/** Owns one real provider turn whose completion the test explicitly releases. */
export async function createControlledStream() {
  const client = await connectDaemonClient<ControlledStreamClient>({
    clientIdPrefix: "controlled-stream",
  });
  const previous = await client.getDaemonConfig();
  let appended = false;
  const emit = (chunks: string[], finish: boolean) =>
    client.invokePluginRpc("controlled-stream-test", "append", { chunks, finish });
  const cleanup = async () => {
    try {
      if (appended) await emit([], true);
      await client.removePlugin("controlled-stream-test");
    } finally {
      try {
        await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled });
      } finally {
        await client.close();
      }
    }
  };
  try {
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(
      path.resolve(__dirname, "../fixtures/controlled-stream-plugin"),
    );
    return {
      provider: "controlled-stream",
      append: async (chunks: string[]) => {
        await emit(chunks, false);
        appended = true;
      },
      finish: async (chunks: string[] = []) => {
        await emit(chunks, true);
      },
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
