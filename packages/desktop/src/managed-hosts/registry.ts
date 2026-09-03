import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  ManagedHostRegistrySchema,
  type ManagedHostRegistry,
} from "@getpaseo/protocol/managed-hosts";

const MANAGED_HOSTS_FILE_ENV = "PASEO_MANAGED_HOSTS_FILE";

interface ManagedHostRegistryLocation {
  env: NodeJS.ProcessEnv;
  homeDirectory: string;
}

export function resolveManagedHostRegistryPath(input: ManagedHostRegistryLocation): string {
  const configuredPath = input.env[MANAGED_HOSTS_FILE_ENV]?.trim();
  if (configuredPath) {
    return path.resolve(configuredPath);
  }
  const configDirectory =
    input.env.XDG_CONFIG_HOME?.trim() || path.join(input.homeDirectory, ".config");
  return path.join(configDirectory, "paseo", "managed-hosts.json");
}

export async function readManagedHostRegistry(
  input: ManagedHostRegistryLocation,
): Promise<ManagedHostRegistry | null> {
  const registryPath = resolveManagedHostRegistryPath(input);
  let serialized: string;
  try {
    serialized = await readFile(registryPath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  return ManagedHostRegistrySchema.parse(JSON.parse(serialized));
}
