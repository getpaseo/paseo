import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface PackageInfo {
  root: string;
}

export function assertPathExists(input: { label: string; filePath: string }): string {
  if (!existsSync(input.filePath)) {
    throw new Error(`${input.label} is missing at ${input.filePath}`);
  }

  return input.filePath;
}

export function findPackageRootFromResolvedPath(input: {
  resolvedPath: string;
  packageName: string;
}): PackageInfo {
  let currentDir = path.dirname(input.resolvedPath);

  while (true) {
    const packageJsonPath = path.join(currentDir, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
          name?: string;
        };
        if (pkg.name === input.packageName) {
          return {
            root: currentDir,
          };
        }
      } catch {
        // Ignore malformed package metadata while walking up.
      }
    }

    const parent = path.dirname(currentDir);
    if (parent === currentDir) {
      break;
    }
    currentDir = parent;
  }

  throw new Error(`Unable to resolve ${input.packageName} package root`);
}

export function resolvePackagedAsarPath(): string {
  return path.join(process.resourcesPath, "app.asar");
}
