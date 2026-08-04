import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PackageVersionResolutionError, resolvePackageVersion } from "./package-version.js";

const SERVER_PACKAGE_NAME = "@getpaseo/server";
const RELEASE_TAG_PATTERN = /^v(?<version>\d+\.\d+\.\d+(?:-(?:beta|fork)\.\d+)?)$/;

export class DaemonVersionResolutionError extends PackageVersionResolutionError {}

function resolveCheckoutVersion(moduleUrl: string): string | null {
  try {
    const tag = execFileSync("git", ["describe", "--tags", "--exact-match", "HEAD"], {
      cwd: path.dirname(fileURLToPath(moduleUrl)),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return RELEASE_TAG_PATTERN.exec(tag)?.groups?.version ?? null;
  } catch {
    return null;
  }
}

export function resolveDaemonVersion(moduleUrl: string = import.meta.url): string {
  const checkoutVersion = resolveCheckoutVersion(moduleUrl);
  if (checkoutVersion) {
    return checkoutVersion;
  }

  try {
    return resolvePackageVersion({
      moduleUrl,
      packageName: SERVER_PACKAGE_NAME,
    });
  } catch (error) {
    if (error instanceof PackageVersionResolutionError) {
      throw new DaemonVersionResolutionError({
        moduleUrl,
        packageName: SERVER_PACKAGE_NAME,
      });
    }
    throw error;
  }
}
