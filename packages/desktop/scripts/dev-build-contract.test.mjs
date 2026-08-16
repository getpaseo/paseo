import { execFile } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

const desktopDir = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(desktopDir, "../..");
const execFileAsync = promisify(execFile);
const npmCommand = process.platform === "win32" ? process.execPath : "npm";
const npmPrefixArgs =
  process.platform === "win32" ? [requireEnvironmentVariable("npm_execpath")] : [];
const prerequisite = "npm run dev:prerequisites";

function requireEnvironmentVariable(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required to invoke npm on Windows`);
  return value;
}

describe("desktop dev build contract", () => {
  test("runs one prerequisite before either platform dev entry point", async () => {
    const packageJson = JSON.parse(await readFile(path.join(desktopDir, "package.json"), "utf8"));
    const devScript = await readFile(path.join(import.meta.dirname, "dev.sh"), "utf8");

    expect(packageJson.scripts.predev).toBe(prerequisite);
    expect(packageJson.scripts["predev:win"]).toBe(prerequisite);
    expect(packageJson.scripts["dev:prerequisites"]).toBe(
      "npm --prefix ../.. run build:server-deps && npm --prefix ../.. run build --workspace=@getpaseo/server",
    );
    expect(packageJson.scripts.dev).toBe("./scripts/dev.sh");
    expect(packageJson.scripts["dev:win"]).toBe("powershell ./scripts/dev.ps1");
    expect(devScript.indexOf("npm run build:main")).toBeLessThan(
      devScript.indexOf('exec node "$SCRIPT_DIR/dev-runner.mjs"'),
    );
  });

  test("builds the private runtime fixture before renderer acceptance", async () => {
    const packageJson = JSON.parse(await readFile(path.join(desktopDir, "package.json"), "utf8"));

    expect(packageJson.scripts["pretest:e2e:renderer"]).toBe(
      "npm --prefix ../.. run build:workspace-runtime-fixture",
    );
  });

  test("the public prerequisite repairs missing and stale server artifacts in an isolated checkout", async () => {
    const isolatedRoot = await createIsolatedBuildCheckout();
    const staleServerExport = path.join(
      isolatedRoot,
      "packages/server/dist/server/server/exports.js",
    );
    const staleSourceExport = path.join(isolatedRoot, "packages/server/src/server/exports.ts");
    const missingServerExport = path.join(
      isolatedRoot,
      "packages/server/dist/server/server/session.js",
    );
    const missingSourceExport = path.join(isolatedRoot, "packages/server/src/server/session.ts");

    await mkdir(path.dirname(staleServerExport), { recursive: true });
    await writeFile(staleServerExport, "// stale isolated artifact\n");
    const staleTime = new Date(0);
    await utimes(staleServerExport, staleTime, staleTime);

    try {
      await runPrerequisite(isolatedRoot);
      await expect(access(missingServerExport)).resolves.toBeUndefined();
      expect(await readFile(staleServerExport, "utf8")).not.toContain("stale isolated artifact");
      expect((await stat(staleServerExport)).mtimeMs).toBeGreaterThanOrEqual(
        (await stat(staleSourceExport)).mtimeMs,
      );
      expect((await stat(missingServerExport)).mtimeMs).toBeGreaterThanOrEqual(
        (await stat(missingSourceExport)).mtimeMs,
      );
    } finally {
      await rm(isolatedRoot, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  }, 130_000);
});

async function createIsolatedBuildCheckout() {
  const isolatedRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-desktop-build-contract-"));
  const packageDirectories = [
    "packages/client",
    "packages/desktop",
    "packages/highlight",
    "packages/plugin",
    "packages/protocol",
    "packages/relay",
    "packages/server",
    "packages/workspace-runtime-contract",
    "packages/workspace-helper",
  ];

  try {
    await Promise.all([
      ...["package.json", "package-lock.json", "tsconfig.base.json", "tsconfig.json"].map((file) =>
        cp(path.join(repoRoot, file), path.join(isolatedRoot, file)),
      ),
      cp(path.join(repoRoot, "scripts"), path.join(isolatedRoot, "scripts"), {
        recursive: true,
      }),
      ...packageDirectories.map(async (relativeDirectory) => {
        const target = path.join(isolatedRoot, relativeDirectory);
        await mkdir(path.dirname(target), { recursive: true });
        await cp(path.join(repoRoot, relativeDirectory), target, {
          recursive: true,
          filter: (source) =>
            !source.endsWith(`${path.sep}dist`) &&
            !source.endsWith(`${path.sep}node_modules`) &&
            !source.endsWith(`${path.sep}test-results`),
        });
      }),
    ]);
    await symlink(path.join(repoRoot, "node_modules"), path.join(isolatedRoot, "node_modules"));
    await Promise.all(
      packageDirectories.map((relativeDirectory) =>
        symlink(
          path.join(repoRoot, relativeDirectory, "node_modules"),
          path.join(isolatedRoot, relativeDirectory, "node_modules"),
        ),
      ),
    );
    return isolatedRoot;
  } catch (error) {
    await rm(isolatedRoot, { recursive: true, force: true });
    throw error;
  }
}

async function runPrerequisite(isolatedRoot) {
  try {
    await execFileAsync(
      npmCommand,
      [...npmPrefixArgs, "run", "dev:prerequisites", "--workspace=@getpaseo/desktop"],
      {
        cwd: isolatedRoot,
        timeout: 120_000,
      },
    );
  } catch (error) {
    throw new Error(`${error.stdout ?? ""}\n${error.stderr ?? ""}`, { cause: error });
  }
}
