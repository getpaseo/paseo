import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { isRealpathInsideRoot } from "../../../utils/path.js";
import {
  PASEO_CLI_PACKAGE,
  type GlobalCliPackageManager,
  type GlobalPaseoInstall,
  type PackageManagerName,
} from "./global-cli.js";

const PackageJsonSchema = z.object({ name: z.string().optional() }).passthrough();

export interface DaemonInstallOriginRuntime {
  resolveCurrentServerPackageRoot(): string | null;
}

export const daemonInstallOriginRuntime: DaemonInstallOriginRuntime = {
  resolveCurrentServerPackageRoot,
};

export interface GlobalCliSelfUpdateTarget {
  manager: GlobalCliPackageManager;
  install: GlobalPaseoInstall;
}

export type ResolveGlobalCliSelfUpdateResult =
  | { ok: true; target: GlobalCliSelfUpdateTarget }
  | { ok: false; error: string };

/**
 * Picks the package manager whose global `@getpaseo/cli` install is actually
 * running this daemon, so self-update updates the thing the user is running.
 *
 * Managers are probed in order; the first one whose global install contains the
 * running daemon wins. When the owning install is linked or version-mismatched,
 * its reason is returned instead of silently falling through to another manager.
 */
export async function resolveGlobalCliSelfUpdate(
  managers: readonly GlobalCliPackageManager[],
  daemonVersion: string | null,
  runtime: DaemonInstallOriginRuntime = daemonInstallOriginRuntime,
): Promise<ResolveGlobalCliSelfUpdateResult> {
  const currentServerPackageRoot = runtime.resolveCurrentServerPackageRoot();
  if (!currentServerPackageRoot) {
    return {
      ok: false,
      error: `Unable to verify that this daemon is running from a global ${PASEO_CLI_PACKAGE} install.`,
    };
  }

  const installedManagers: PackageManagerName[] = [];
  for (const manager of managers) {
    const install = await manager.inspect();
    if (!install) {
      continue;
    }
    installedManagers.push(manager.name);

    if (!installContainsDaemon(install, currentServerPackageRoot)) {
      continue;
    }

    const reason = validateOwningInstall(install, daemonVersion);
    return reason ? { ok: false, error: reason } : { ok: true, target: { manager, install } };
  }

  if (installedManagers.length === 0) {
    return {
      ok: false,
      error: `${PASEO_CLI_PACKAGE} is not installed globally with npm or pnpm on this host.`,
    };
  }

  return {
    ok: false,
    error: `This daemon is not running from a global ${PASEO_CLI_PACKAGE} install.`,
  };
}

function installContainsDaemon(
  install: GlobalPaseoInstall,
  currentServerPackageRoot: string,
): boolean {
  return install.containmentRoots.some((root) =>
    isRealpathInsideRoot(root, currentServerPackageRoot),
  );
}

function validateOwningInstall(
  install: GlobalPaseoInstall,
  daemonVersion: string | null,
): string | null {
  if (install.isLinked) {
    return `The global ${PASEO_CLI_PACKAGE} install is linked; self-update only supports normal global installs.`;
  }

  if (daemonVersion && install.version !== daemonVersion) {
    return `This daemon is not running from the global ${PASEO_CLI_PACKAGE} install (global ${install.packageManager} has ${install.version}, daemon is ${daemonVersion}).`;
  }

  return null;
}

function resolveCurrentServerPackageRoot(): string | null {
  return resolvePackageRootFrom(fileURLToPath(import.meta.url), "@getpaseo/server");
}

function resolvePackageRootFrom(startPath: string, packageName: string): string | null {
  let currentDir = path.dirname(startPath);

  while (true) {
    const packageJsonPath = path.join(currentDir, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const packageJson = PackageJsonSchema.parse(
          JSON.parse(readFileSync(packageJsonPath, "utf8")),
        );
        if (packageJson.name === packageName) {
          return currentDir;
        }
      } catch {
        return null;
      }
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}
