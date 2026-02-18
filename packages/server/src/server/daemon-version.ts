import {
  PackageVersionResolutionError,
  resolvePackageVersion,
} from "./package-version.js";

const SERVER_PACKAGE_NAME = "@getpaseo/server";

export class DaemonVersionResolutionError extends PackageVersionResolutionError {}

export function resolveDaemonVersion(moduleUrl: string = import.meta.url): string {
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
