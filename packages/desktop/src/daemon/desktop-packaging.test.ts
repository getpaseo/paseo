import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const STABLE_MACOS_PATH =
  "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

function writeExecutable(filePath: string, contents: string): void {
  writeFileSync(filePath, contents, "utf8");
  chmodSync(filePath, 0o755);
}

function createFakeMacBundle(options: { includeHelper: boolean }): {
  root: string;
  shimPath: string;
  daemonLauncherPath: string;
  resourcesPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), "paseo-cli-shim-test-"));
  const appPath = join(root, "Paseo.app");
  const contentsPath = join(appPath, "Contents");
  const resourcesPath = join(contentsPath, "Resources");
  const shimPath = join(resourcesPath, "bin", "paseo");
  const daemonLauncherPath = join(resourcesPath, "bin", "paseo-daemon-launcher");
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
  copyFileSync(join(packageRoot, "bin", "paseo-daemon-launcher"), daemonLauncherPath);
  chmodSync(daemonLauncherPath, 0o755);

  writeExecutable(mainPath, "#!/bin/sh\necho main-executable\n");

  if (options.includeHelper) {
    mkdirSync(dirname(helperPath), { recursive: true });
    writeExecutable(
      helperPath,
      [
        "#!/bin/sh",
        'printf "helper env=%s/%s cli=%s web=%s\\n" "$ELECTRON_RUN_AS_NODE" "$PASEO_NODE_ENV" "$PASEO_CLI" "${PASEO_WEB_UI_ENABLED:-}"',
        'printf "path=%s\\n" "$PATH"',
        'printf "args=%s\\n" "$*"',
        'exit "${PASEO_HELPER_EXIT_CODE:-0}"',
        "",
      ].join("\n"),
    );
  }

  return { root, shimPath, daemonLauncherPath, resourcesPath };
}

describe("desktop packaging", () => {
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

  it("registers Paseo agent links with the operating system", () => {
    const config = readFileSync(join(packageRoot, "electron-builder.yml"), "utf8");

    expect(config).toContain("name: Paseo agent link");
    expect(config).toContain("- paseo");
  });

  it("packages the executable daemon launcher in the macOS resources", () => {
    const config = readFileSync(join(packageRoot, "electron-builder.yml"), "utf8");
    const launcherPath = join(packageRoot, "bin", "paseo-daemon-launcher");

    expect(config).toContain(
      "- from: bin/paseo-daemon-launcher\n      to: bin/paseo-daemon-launcher",
    );
    expect(statSync(launcherPath).mode & 0o111).toBe(0o111);
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

  it("prepends stable macOS command paths and preserves the inherited PATH", () => {
    if (process.platform === "win32") return;

    const bundle = createFakeMacBundle({ includeHelper: true });
    try {
      const result = spawnSync(bundle.daemonLauncherPath, [], {
        encoding: "utf8",
        env: { ...process.env, PATH: "/custom/bin:/custom/sbin" },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        `helper env=1/production cli=${join(bundle.resourcesPath, "bin", "paseo")} web=false`,
      );
      expect(result.stdout).toContain(`path=${STABLE_MACOS_PATH}:/custom/bin:/custom/sbin\n`);
      expect(result.stdout).toContain("node-entrypoint-runner.js");
      expect(result.stdout).toContain("node-script");
      expect(result.stdout).toContain("@getpaseo/server/dist/scripts/supervisor-entrypoint.js");
    } finally {
      rmSync(bundle.root, { recursive: true, force: true });
    }
  });

  it("consumes an explicit stop intent without launching the daemon", () => {
    if (process.platform === "win32") return;

    const bundle = createFakeMacBundle({ includeHelper: true });
    const paseoHome = join(bundle.root, "paseo-home");
    const stopIntentPath = join(paseoHome, "daemon-explicit-stop");
    mkdirSync(paseoHome, { recursive: true });
    writeFileSync(stopIntentPath, "4242\n", "utf8");

    try {
      const result = spawnSync(bundle.daemonLauncherPath, [], {
        encoding: "utf8",
        env: {
          ...process.env,
          PASEO_HOME: paseoHome,
          PASEO_HELPER_EXIT_CODE: "23",
        },
      });

      expect(result.status).toBe(0);
      expect(existsSync(stopIntentPath)).toBe(false);
      expect(result.stdout).not.toContain("helper env=");
    } finally {
      rmSync(bundle.root, { recursive: true, force: true });
    }
  });

  it("propagates an unexpected daemon failure to launchd", () => {
    if (process.platform === "win32") return;

    const bundle = createFakeMacBundle({ includeHelper: true });
    try {
      const result = spawnSync(bundle.daemonLauncherPath, [], {
        encoding: "utf8",
        env: { ...process.env, PASEO_HELPER_EXIT_CODE: "23" },
      });

      expect(result.status).toBe(23);
      expect(result.stdout).toContain("helper env=");
    } finally {
      rmSync(bundle.root, { recursive: true, force: true });
    }
  });

  it("does not read user shell startup files", () => {
    if (process.platform === "win32") return;

    const bundle = createFakeMacBundle({ includeHelper: true });
    const home = join(bundle.root, "home");
    const startupFile = join(home, "startup-file");
    const startupMarker = join(home, "startup-file-read");
    mkdirSync(home, { recursive: true });
    writeFileSync(startupFile, ': > "$PASEO_STARTUP_MARKER"\nexit 91\n', "utf8");
    for (const name of [".profile", ".zprofile", ".zshrc", ".zshenv"]) {
      copyFileSync(startupFile, join(home, name));
    }

    try {
      const result = spawnSync(bundle.daemonLauncherPath, [], {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          SHELL: "/bin/zsh",
          ENV: startupFile,
          BASH_ENV: startupFile,
          PASEO_STARTUP_MARKER: startupMarker,
        },
      });

      expect(result.status).toBe(0);
      expect(existsSync(startupMarker)).toBe(false);
    } finally {
      rmSync(bundle.root, { recursive: true, force: true });
    }
  });
});
