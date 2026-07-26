import type { ContainerBackend } from "./container-backend.js";

export interface AvailableBackendInfo {
  id: string;
  label: string;
  available: boolean;
  hasConfig: boolean;
}

export interface ContainerBackendRegistry {
  get(id: string | null): ContainerBackend | null;
  list(): ContainerBackend[];
  listAvailable(cwd: string): Promise<AvailableBackendInfo[]>;
  findAvailableForCwd(cwd: string): Promise<ContainerBackend | null>;
}

export function createContainerBackendRegistry(
  backends: ContainerBackend[],
): ContainerBackendRegistry {
  const byId = new Map(backends.map((b) => [b.id, b]));
  return {
    get(id) {
      return id ? (byId.get(id) ?? null) : null;
    },
    list() {
      return [...backends];
    },
    async listAvailable(cwd) {
      const results: AvailableBackendInfo[] = [];
      for (const backend of backends) {
        let available = false;
        try {
          available = await backend.isAvailable();
        } catch {
          available = false;
        }
        results.push({
          id: backend.id,
          label: backend.label,
          available,
          hasConfig: backend.hasConfig(cwd),
        });
      }
      return results;
    },
    async findAvailableForCwd(cwd) {
      for (const backend of backends) {
        try {
          if ((await backend.isAvailable()) && backend.hasConfig(cwd)) return backend;
        } catch {
          continue;
        }
      }
      return null;
    },
  };
}
