import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { app } from "electron";
import type { NodeEntrypointSpec } from "../node-entrypoint-launcher.js";
import {
  assertPathExists,
  findPackageRootFromResolvedPath,
  resolvePackagedAsarPath,
} from "../package-paths.js";

const CLI_PACKAGE_NAME = "@getpaseo/cli";
const CLI_BIN_ENTRY = `${CLI_PACKAGE_NAME}/bin/paseo`;
const CLI_RUN_ENTRY = `${CLI_PACKAGE_NAME}/dist/run.js`;

const esmRequire = createRequire(__filename);

function resolveCliPackageRoot(): string {
  return findPackageRootFromResolvedPath({
    resolvedPath: esmRequire.resolve(CLI_BIN_ENTRY),
    packageName: CLI_PACKAGE_NAME,
  }).root;
}

export function resolveExternalCliEntrypoint(): NodeEntrypointSpec {
  if (app.isPackaged) {
    return {
      entryPath: assertPathExists({
        label: "Bundled external CLI entrypoint",
        filePath: path.join(
          resolvePackagedAsarPath(),
          "node_modules",
          "@getpaseo",
          "cli",
          "dist",
          "index.js",
        ),
      }),
      execArgv: [],
    };
  }

  const cliRoot = resolveCliPackageRoot();
  const distEntry = path.join(cliRoot, "dist", "index.js");
  if (existsSync(distEntry)) {
    return {
      entryPath: distEntry,
      execArgv: [],
    };
  }

  return {
    entryPath: assertPathExists({
      label: "External CLI source entrypoint",
      filePath: path.join(cliRoot, "src", "index.ts"),
    }),
    execArgv: ["--import", "tsx"],
  };
}

export function resolvePassthroughCliEntrypoint(): string {
  if (app.isPackaged) {
    return assertPathExists({
      label: "Bundled passthrough CLI entrypoint",
      filePath: path.join(
        resolvePackagedAsarPath(),
        "node_modules",
        "@getpaseo",
        "cli",
        "dist",
        "run.js",
      ),
    });
  }

  return assertPathExists({
    label: "Passthrough CLI entrypoint",
    filePath: esmRequire.resolve(CLI_RUN_ENTRY),
  });
}
