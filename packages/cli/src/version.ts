import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

type CliPackageJson = {
  version?: unknown;
};

export function resolveCliVersion(): string {
  const packageJson = require("../package.json") as CliPackageJson;
  if (typeof packageJson.version === "string" && packageJson.version.trim().length > 0) {
    return packageJson.version.trim();
  }
  throw new Error("Unable to resolve @getpaseo/cli version from package.json.");
}
