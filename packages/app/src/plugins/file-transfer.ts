import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { PluginFileTransfer, PluginPickedFile } from "@getpaseo/plugin/client";
import { PLUGIN_FILE_HEADER_MAX_BYTES, PLUGIN_FILE_MAX_BYTES } from "@getpaseo/plugin/client/host";
import { pickDeviceFile } from "./pick-device-file";
import type { DeviceFileSelection } from "./pick-device-file.types";

const HANDLE_TTL_MS = 5 * 60 * 1000;

export function createPluginFileTransfer(
  client: Pick<DaemonClient, "canSendSensitiveFiles" | "invokePluginRpc">,
  pluginId: string,
  signal: AbortSignal,
): PluginFileTransfer {
  const handles = new WeakMap<
    PluginPickedFile,
    { selection: DeviceFileSelection; expiresAt: number }
  >();
  let picking = false;

  function checkConnection() {
    if (signal.aborted) throw new Error("This plugin session has ended.");
    if (!client.canSendSensitiveFiles) {
      throw new Error("Connect to this host over a protected connection to send a file.");
    }
  }

  return {
    async pick() {
      checkConnection();
      if (picking) return null;
      picking = true;
      try {
        const selection = await pickDeviceFile();
        if (!selection) return null;
        checkConnection();
        if (
          !Number.isSafeInteger(selection.size) ||
          selection.size < 0 ||
          selection.size > PLUGIN_FILE_MAX_BYTES
        ) {
          throw new Error("Choose a file no larger than 1 MiB.");
        }
        const file = Object.freeze({
          name: selection.name,
          size: selection.size,
        }) as PluginPickedFile;
        handles.set(file, { selection, expiresAt: Date.now() + HANDLE_TTL_MS });
        return file;
      } finally {
        picking = false;
      }
    },
    async send(file, rpc, header) {
      checkConnection();
      const entry = handles.get(file);
      if (!entry || entry.expiresAt <= Date.now())
        throw new Error("Choose the file again to continue.");
      if (header && header.byteLength > PLUGIN_FILE_HEADER_MAX_BYTES) {
        throw new Error("File transfer metadata is too large.");
      }
      handles.delete(file);
      const metadata = header?.slice();
      const bytes = await entry.selection.read();
      const payload = new Uint8Array((metadata?.byteLength ?? 0) + bytes.byteLength);
      try {
        if (bytes.byteLength !== file.size) throw new Error("The file changed. Choose it again.");
        checkConnection();
        if (metadata) payload.set(metadata);
        payload.set(bytes, metadata?.byteLength ?? 0);
        const result = await client.invokePluginRpc(pluginId, rpc.name, payload);
        return await rpc.output.parseAsync(result);
      } finally {
        payload.fill(0);
        bytes.fill(0);
      }
    },
  };
}
