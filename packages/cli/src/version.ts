import { createRequire } from "node:module";

declare const __PASEO_CLI_VERSION__: string | undefined;

interface CliPackageJson {
  version?: unknown;
}

export function resolveCliVersion(): string {
  if (typeof __PASEO_CLI_VERSION__ === "string" && __PASEO_CLI_VERSION__.length > 0) {
    return __PASEO_CLI_VERSION__;
  }
  const require = createRequire(import.meta.url);
  const packageJson = require("../package.json") as CliPackageJson;
  if (typeof packageJson.version === "string" && packageJson.version.trim().length > 0) {
    return packageJson.version.trim();
  }
  throw new Error("Unable to resolve @getpaseo/cli version from package.json.");
}
