import type {
  PluginClientBundle,
  PluginClientBundleStore,
} from "@getpaseo/client/internal/daemon-client";

/** Each adapter is scoped to one host. Writes publish a complete file/record atomically. */
export interface PluginBundleFiles {
  list(): Promise<string[]>;
  read(name: string): Promise<string>;
  writeAtomic(name: string, contents: string): Promise<void>;
  remove(name: string): Promise<void>;
}

export function createPluginClientBundleStore(
  files: PluginBundleFiles,
  sha256: (contents: string) => Promise<string>,
): PluginClientBundleStore {
  const verified = new Set<string>();
  const filename = (bundle: PluginClientBundle) =>
    `${encodeURIComponent(bundle.id)}.${bundle.clientBundleHash}.js`;
  return {
    async load() {
      const bundles: PluginClientBundle[] = [];
      for (const name of await files.list()) {
        try {
          const match = /^(.*)\.([a-f0-9]{64})\.js$/.exec(name);
          if (!match) continue;
          const id = decodeURIComponent(match[1]!);
          const clientBundleHash = match[2]!;
          const clientBundle = await files.read(name);
          if ((await sha256(clientBundle)) !== clientBundleHash) continue;
          verified.add(name);
          bundles.push({ id, clientBundleHash, clientBundle });
        } catch {
          // Missing, unreadable or corrupt files are cache misses, never executable code.
        }
      }
      return bundles;
    },
    async replace(bundles) {
      const retained = new Set<string>();
      for (const bundle of bundles) {
        const name = filename(bundle);
        retained.add(name);
        if (verified.has(name)) continue;
        await files.writeAtomic(name, bundle.clientBundle);
        verified.add(name);
      }
      for (const name of await files.list()) {
        if (retained.has(name)) continue;
        await files.remove(name);
        verified.delete(name);
      }
    },
  };
}
