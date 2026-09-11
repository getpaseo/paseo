import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

interface PackageManifest {
  exports: Record<string, Record<string, string>>;
}

interface PackResult {
  files: Array<{ path: string }>;
}

function runtimeExportTargets(manifest: PackageManifest): string[] {
  const targets: string[] = [];
  for (const conditions of Object.values(manifest.exports)) {
    for (const condition of ["node", "import", "default"]) {
      const target = conditions[condition];
      if (target) targets.push(target);
    }
  }
  return targets;
}

describe("published package exports", () => {
  it("includes every runtime export target in the npm package", async () => {
    const npmCli = process.env.npm_execpath;
    if (!npmCli) throw new Error("npm_execpath is required to inspect the package artifact");

    const temporaryDirectory = await mkdtemp(join(tmpdir(), "paseo-relay-pack-"));
    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [npmCli, "pack", "--dry-run", "--json", "--silent"],
        {
          cwd: packageRoot,
          env: { ...process.env, npm_config_cache: join(temporaryDirectory, "npm-cache") },
        },
      );
      const [packResult] = JSON.parse(stdout) as PackResult[];
      const packedFiles = new Set(packResult.files.map((file) => file.path));
      const manifest = JSON.parse(
        await readFile(join(packageRoot, "package.json"), "utf8"),
      ) as PackageManifest;
      const missingTargets = runtimeExportTargets(manifest)
        .map((target) => target.replace(/^\.\//, ""))
        .filter((target) => !packedFiles.has(target));

      expect(missingTargets).toEqual([]);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
