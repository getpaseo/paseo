import * as FileSystem from "expo-file-system/legacy";
import { CryptoDigestAlgorithm, digestStringAsync, randomUUID } from "expo-crypto";
import { createPluginClientBundleStore } from "./store";

export function createHostPluginClientBundleStore(serverId: string) {
  const directory = `${FileSystem.cacheDirectory}plugin-client-bundles/${encodeURIComponent(serverId)}/`;
  const ensureDirectory = async () => {
    if (!FileSystem.cacheDirectory) throw new Error("Plugin bundle cache directory unavailable");
    await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  };
  return createPluginClientBundleStore(
    {
      async list() {
        await ensureDirectory();
        return FileSystem.readDirectoryAsync(directory);
      },
      read: (name) => FileSystem.readAsStringAsync(`${directory}${name}`),
      async writeAtomic(name, contents) {
        await ensureDirectory();
        const temporary = `${directory}${randomUUID()}.tmp`;
        try {
          await FileSystem.writeAsStringAsync(temporary, contents);
          await FileSystem.moveAsync({ from: temporary, to: `${directory}${name}` });
        } finally {
          await FileSystem.deleteAsync(temporary, { idempotent: true });
        }
      },
      remove: (name) => FileSystem.deleteAsync(`${directory}${name}`, { idempotent: true }),
    },
    (contents) => digestStringAsync(CryptoDigestAlgorithm.SHA256, contents),
  );
}
