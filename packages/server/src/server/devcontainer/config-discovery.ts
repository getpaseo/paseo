import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Dev Container Specification — devcontainer.json discovery locations, in order of precedence:
 *   1. .devcontainer/devcontainer.json
 *   2. .devcontainer.json
 *   3. .devcontainer/<folder>/devcontainer.json (one level deep)
 *
 * See: https://containers.dev/implementors/spec/#devcontainerjson
 */

export interface DevContainerConfigPath {
  /** Absolute path to the discovered devcontainer.json */
  configPath: string;
  /** The workspace folder (cwd) that contains the .devcontainer directory or file */
  workspaceFolder: string;
}

/**
 * Search for a devcontainer.json in the given workspace folder using the spec's
 * precedence rules. Returns the first match or null if none is found.
 */
export function discoverDevContainerConfig(workspaceFolder: string): DevContainerConfigPath | null {
  const cwd = resolve(workspaceFolder);

  // 1. .devcontainer/devcontainer.json
  const primary = join(cwd, ".devcontainer", "devcontainer.json");
  if (existsSync(primary)) {
    return { configPath: primary, workspaceFolder: cwd };
  }

  // 2. .devcontainer.json (repo root)
  const rootLevel = join(cwd, ".devcontainer.json");
  if (existsSync(rootLevel)) {
    return { configPath: rootLevel, workspaceFolder: cwd };
  }

  // 3. .devcontainer/<folder>/devcontainer.json (one level deep)
  const devcontainerDir = join(cwd, ".devcontainer");
  if (existsSync(devcontainerDir)) {
    try {
      // Sorted so the choice between sibling configs is stable rather than
      // dependent on filesystem enumeration order.
      const entries = readdirSync(devcontainerDir).sort();
      for (const entry of entries) {
        if (entry === "devcontainer.json") continue; // already checked in step 1
        const candidate = join(devcontainerDir, entry, "devcontainer.json");
        if (existsSync(candidate)) {
          return { configPath: candidate, workspaceFolder: cwd };
        }
      }
    } catch {
      // Directory not readable — treat as no config found
    }
  }

  return null;
}
