import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { isRealpathInsideRoot } from "../../../utils/path.js";
import { PASEO_CLI_PACKAGE, type NpmGlobalPaseoInstall } from "./npm-global-cli.js";

const PackageJsonSchema = z.object({ name: z.string().optional() }).passthrough();

export interface DaemonInstallOriginRuntime {
  resolveCurrentServerPackageRoot(): string | null;
}

export const daemonInstallOriginRuntime: DaemonInstallOriginRuntime = {
  resolveCurrentServerPackageRoot,
};

export function validateDaemonInstallOrigin(
  install: NpmGlobalPaseoInstall,
  daemonVersion: string | null,
  runtime: DaemonInstallOriginRuntime = daemonInstallOriginRuntime,
): string | null {
  if (install.isLinked) {
    return `The global ${PASEO_CLI_PACKAGE} install is linked; self-update only supports normal npm global installs.`;
  }

  if (daemonVersion && install.version !== daemonVersion) {
    return `This daemon is not running from the npm global ${PASEO_CLI_PACKAGE} install (global npm has ${install.version}, daemon is ${daemonVersion}).`;
  }

  const currentServerPackageRoot = runtime.resolveCurrentServerPackageRoot();
  if (!currentServerPackageRoot) {
    return "Unable to verify that this daemon is running from an npm global install.";
  }

  if (!isCurrentServerUnderNpmInstall(currentServerPackageRoot, install)) {
    return `This daemon is not running from the npm global ${PASEO_CLI_PACKAGE} install.`;
  }

  return null;
}

function isCurrentServerUnderNpmInstall(
  currentServerPackageRoot: string,
  install: NpmGlobalPaseoInstall,
): boolean {
  const roots = install.globalRootPath
    ? [install.packagePath, globalNodeModulesPath(install.globalRootPath)]
    : [install.packagePath];

  return roots.some((root) => isRealpathInsideRoot(root, currentServerPackageRoot));
}

function globalNodeModulesPath(globalRootPath: string): string {
  const normalized = path.normalize(globalRootPath);
  return path.basename(normalized) === "node_modules"
    ? normalized
    : path.join(normalized, "node_modules");
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
