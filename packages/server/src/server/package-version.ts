import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type ResolvePackageVersionParams = {
  moduleUrl?: string;
  packageName: string;
};

type PackageJson = {
  name?: unknown;
  version?: unknown;
};

export class PackageVersionResolutionError extends Error {
  constructor(params: { moduleUrl: string; packageName: string }) {
    super(
      `Unable to resolve ${params.packageName} version from module URL ${params.moduleUrl}.`
    );
    this.name = "PackageVersionResolutionError";
  }
}

export function resolvePackageVersion(params: ResolvePackageVersionParams): string {
  const moduleUrl = params.moduleUrl ?? import.meta.url;
  let currentDir = path.dirname(fileURLToPath(moduleUrl));

  while (true) {
    const packageJsonPath = path.join(currentDir, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as PackageJson;
        if (packageJson.name === params.packageName) {
          if (
            typeof packageJson.version === "string" &&
            packageJson.version.trim().length > 0
          ) {
            return packageJson.version.trim();
          }
          throw new PackageVersionResolutionError({
            moduleUrl,
            packageName: params.packageName,
          });
        }
      } catch (error) {
        if (error instanceof PackageVersionResolutionError) {
          throw error;
        }
        // Continue searching parent directories.
      }
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  throw new PackageVersionResolutionError({
    moduleUrl,
    packageName: params.packageName,
  });
}
