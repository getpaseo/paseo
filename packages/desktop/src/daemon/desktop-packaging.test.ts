import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const requireFromHere = createRequire(import.meta.url);
const afterPack = requireFromHere("../../scripts/after-pack.js").default as (context: {
  appOutDir: string;
  arch: number;
  electronPlatformName: string;
}) => Promise<void>;

function writeExecutable(filePath: string, contents: string): void {
  writeFileSync(filePath, contents, "utf8");
  chmodSync(filePath, 0o755);
}

function createFakeMacBundle(options: { includeHelper: boolean }): {
  root: string;
  shimPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), "paseo-cli-shim-test-"));
  const appPath = join(root, "Paseo.app");
  const contentsPath = join(appPath, "Contents");
  const resourcesPath = join(contentsPath, "Resources");
  const shimPath = join(resourcesPath, "bin", "paseo");
  const mainPath = join(contentsPath, "MacOS", "Paseo");
  const helperPath = join(
    contentsPath,
    "Frameworks",
    "Paseo Helper.app",
    "Contents",
    "MacOS",
    "Paseo Helper",
  );

  mkdirSync(dirname(shimPath), { recursive: true });
  mkdirSync(dirname(mainPath), { recursive: true });
  copyFileSync(join(packageRoot, "bin", "paseo"), shimPath);
  chmodSync(shimPath, 0o755);

  writeExecutable(mainPath, "#!/bin/sh\necho main-executable\n");

  if (options.includeHelper) {
    mkdirSync(dirname(helperPath), { recursive: true });
    writeExecutable(
      helperPath,
      [
        "#!/bin/sh",
        'printf "helper env=%s/%s cli=%s\\n" "$ELECTRON_RUN_AS_NODE" "$PASEO_NODE_ENV" "$PASEO_CLI"',
        'printf "args=%s\\n" "$*"',
        "",
      ].join("\n"),
    );
  }

  return { root, shimPath };
}

function createFakeLinuxApp(): { executablePath: string; originalContents: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "paseo-linux-launcher-test-"));
  const appOutDir = join(root, "packaged app [test]");
  const executablePath = join(appOutDir, "Paseo");
  const originalContents = [
    "#!/usr/bin/env node",
    "process.stdout.write(JSON.stringify(process.argv.slice(2)));",
    "",
  ].join("\n");

  mkdirSync(appOutDir, { recursive: true });
  writeExecutable(executablePath, originalContents);

  return { executablePath, originalContents, root };
}

async function runLinuxAfterPack(appOutDir: string): Promise<void> {
  await afterPack({
    appOutDir,
    arch: -1,
    electronPlatformName: "linux",
  });
}

describe("desktop packaging", () => {
  it("adds --no-sandbox before user arguments for AppImage launches", async () => {
    if (process.platform === "win32") return;

    const app = createFakeLinuxApp();
    try {
      await runLinuxAfterPack(dirname(app.executablePath));

      const userArgs = ["path with spaces", "$(touch should-not-run)", "semi;colon", "*.txt"];
      const result = spawnSync(app.executablePath, userArgs, {
        encoding: "utf8",
        env: { ...process.env, APPIMAGE: "/tmp/Paseo image.AppImage" },
      });

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(["--no-sandbox", ...userArgs]);
    } finally {
      rmSync(app.root, { recursive: true, force: true });
    }
  });

  it("forwards non-AppImage Linux arguments without disabling the sandbox", async () => {
    if (process.platform === "win32") return;

    const app = createFakeLinuxApp();
    try {
      await runLinuxAfterPack(dirname(app.executablePath));
      const env = { ...process.env };
      delete env.APPIMAGE;

      const userArgs = ["path with spaces", "--user-flag=value", "quote'argument"];
      const result = spawnSync(app.executablePath, userArgs, { encoding: "utf8", env });

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(userArgs);
    } finally {
      rmSync(app.root, { recursive: true, force: true });
    }
  });

  it("keeps the Linux launcher executable and the real executable intact when rerun", async () => {
    if (process.platform === "win32") return;

    const app = createFakeLinuxApp();
    try {
      const appOutDir = dirname(app.executablePath);
      await runLinuxAfterPack(appOutDir);
      await runLinuxAfterPack(appOutDir);

      expect(readFileSync(`${app.executablePath}.bin`, "utf8")).toBe(app.originalContents);
      expect(statSync(app.executablePath).mode & 0o111).toBe(0o111);

      const result = spawnSync(app.executablePath, ["after rerun"], {
        encoding: "utf8",
        env: { ...process.env, APPIMAGE: "/tmp/Paseo.AppImage" },
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(["--no-sandbox", "after rerun"]);
    } finally {
      rmSync(app.root, { recursive: true, force: true });
    }
  });

  it("unpacks server zsh shell integration files for external shells", () => {
    const config = readFileSync(join(packageRoot, "electron-builder.yml"), "utf8");

    expect(config).toContain(
      "node_modules/@getpaseo/server/dist/server/terminal/shell-integration/**/*",
    );
    expect(config).not.toContain(
      "node_modules/@getpaseo/server/dist/src/terminal/shell-integration/**/*",
    );
  });

  it("excludes package debug/source files from the packaged app", () => {
    const config = readFileSync(join(packageRoot, "electron-builder.yml"), "utf8");

    expect(config).toContain("!**/*.map");
    expect(config).toContain("!node_modules/@getpaseo/*/src/**");
    expect(config).toContain("!node_modules/@getpaseo/**/*.test.*");
    expect(config).toContain("!node_modules/@getpaseo/**/*.spec.*");
  });

  it("excludes the bundled daemon web UI from the packaged app", () => {
    const config = readFileSync(join(packageRoot, "electron-builder.yml"), "utf8");

    expect(config).toContain("!node_modules/@getpaseo/server/dist/server/web-ui/**");
  });

  it("uses the server skill catalog without a duplicate desktop resource", () => {
    const config = readFileSync(join(packageRoot, "electron-builder.yml"), "utf8");
    const serverPackage = readFileSync(join(packageRoot, "..", "server", "package.json"), "utf8");
    const runtimeTrace = readFileSync(
      join(packageRoot, "..", "..", "scripts", "trace-daemon.mjs"),
      "utf8",
    );

    expect(config).not.toContain("from: ../../skills");
    expect(serverPackage).toContain("fs.rmSync('dist/server/skills',{recursive:true,force:true})");
    expect(serverPackage).toContain("fs.cpSync('../../skills','dist/server/skills'");
    expect(runtimeTrace).toContain('"packages/server/dist/server/skills/**"');
  });

  it("registers Paseo agent links with the operating system", () => {
    const config = readFileSync(join(packageRoot, "electron-builder.yml"), "utf8");

    expect(config).toContain("name: Paseo agent link");
    expect(config).toContain("- paseo");
  });

  // electron-builder packs production dependencies declared in package.json into
  // app.asar. Runtime code in runtime-paths.ts and bin/paseo dynamically resolves
  // these workspace packages by string, so static analysis (TypeScript, Knip) cannot
  // see the link. If a runtime-required workspace dep is dropped from
  // dependencies, the build still succeeds but ships a broken bundle. This
  // assertion is the safety net.
  it("declares all workspace packages required at runtime", () => {
    const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const deps = pkg.dependencies ?? {};

    for (const required of ["@getpaseo/cli", "@getpaseo/server"]) {
      expect(deps[required], `${required} must be declared in dependencies`).toBe("*");
    }
  });

  it("launches the packaged macOS CLI through Helper instead of the main app executable", () => {
    if (process.platform === "win32") return;

    const bundle = createFakeMacBundle({ includeHelper: true });
    try {
      const result = spawnSync(bundle.shimPath, ["--version"], { encoding: "utf8" });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`helper env=1/production cli=${bundle.shimPath}`);
      expect(result.stdout).toContain("node-entrypoint-runner.js");
      expect(result.stdout).toContain("node-script");
      expect(result.stdout).toContain("@getpaseo/cli/dist/index.js");
      expect(result.stdout).toContain("--version");
      expect(result.stdout).not.toContain("main-executable");
    } finally {
      rmSync(bundle.root, { recursive: true, force: true });
    }
  });

  it("fails packaged macOS CLI startup when Helper is missing", () => {
    if (process.platform === "win32") return;

    const bundle = createFakeMacBundle({ includeHelper: false });
    try {
      const result = spawnSync(bundle.shimPath, ["--version"], { encoding: "utf8" });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Bundled Paseo Helper executable not found");
      expect(result.stdout).not.toContain("main-executable");
    } finally {
      rmSync(bundle.root, { recursive: true, force: true });
    }
  });
});
