import type { Dirent } from "node:fs";
import type { Logger } from "pino";
import { readdir, readFile, realpath } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { z } from "zod";

const PackageSchema = z.object({
  packageManager: z.string().optional(),
  scripts: z.record(z.string(), z.string()).optional(),
});

const excludedDirectories = new Set(["node_modules", "dist", "build", "coverage", "vendor"]);
type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface PackageScript {
  command: string;
  cwd: string;
  packageJson: { path: string; script: string };
}

function quoteArgument(value: string): string {
  const escaped =
    process.platform === "win32" ? value.replaceAll("'", "''") : value.replaceAll("'", "'\\''");
  return `'${escaped}'`;
}

function resolveManager(
  manifest: z.infer<typeof PackageSchema> | null,
  names: Set<string>,
  inherited: PackageManager,
): PackageManager {
  const declared = manifest?.packageManager?.split("@")[0];
  if (declared === "npm" || declared === "pnpm" || declared === "yarn" || declared === "bun")
    return declared;
  if (names.has("pnpm-lock.yaml")) return "pnpm";
  if (names.has("yarn.lock")) return "yarn";
  if (names.has("bun.lock") || names.has("bun.lockb")) return "bun";
  if (names.has("package-lock.json") || names.has("npm-shrinkwrap.json")) return "npm";
  return inherited;
}

function isUnreadablePath(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    ["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(String(error.code))
  );
}

/** Discovery is requested by the run menu, never by sidebar snapshot projection. */
export async function discoverPackageScripts(
  root: string,
  logger?: Pick<Logger, "warn">,
): Promise<Map<string, PackageScript>> {
  const scripts = new Map<string, PackageScript>();
  const realRoot = await realpath(root);

  async function visit(directory: string, inherited: PackageManager): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (directory === realRoot || !isUnreadablePath(error)) throw error;
      logger?.warn({ err: error, directory }, "Skipping unreadable package directory");
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    const names = new Set(entries.map((entry) => entry.name));
    let manifest: z.infer<typeof PackageSchema> | null = null;
    const packageFile = entries.find((entry) => entry.name === "package.json" && entry.isFile());
    if (packageFile) {
      const path = join(directory, "package.json");
      try {
        manifest = PackageSchema.parse(JSON.parse(await readFile(path, "utf8")));
      } catch (error) {
        const invalidManifest = error instanceof SyntaxError || error instanceof z.ZodError;
        if (!invalidManifest && !isUnreadablePath(error)) throw error;
        logger?.warn({ err: error, path }, "Skipping invalid or unreadable package manifest");
      }
    }
    const manager = resolveManager(manifest, names, inherited);
    const packagePath = relative(realRoot, join(directory, "package.json")).split(sep).join("/");
    for (const name of Object.keys(manifest?.scripts ?? {})) {
      const id = `package.json:${encodeURIComponent(packagePath)}:${encodeURIComponent(name)}`;
      scripts.set(id, {
        command: `${manager} run ${quoteArgument(name)}`,
        cwd: directory,
        packageJson: { path: packagePath, script: name },
      });
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || excludedDirectories.has(entry.name))
        continue;
      await visit(join(directory, entry.name), manager);
    }
  }

  await visit(realRoot, "npm");
  return scripts;
}

export function packageScriptLabel(script: PackageScript): string {
  const directory = dirname(script.packageJson.path);
  return directory === "."
    ? script.packageJson.script
    : `${directory}: ${script.packageJson.script}`;
}

/** A retained terminal may have been used interactively between runs. */
export function packageScriptCommand(script: PackageScript): string {
  const directory = quoteArgument(script.cwd);
  if (process.platform === "win32") {
    return `Set-Location -LiteralPath ${directory}; if ($?) { ${script.command} }`;
  }
  return `cd -- ${directory} && ${script.command}`;
}
