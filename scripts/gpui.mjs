import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const project = path.join(root, "packages/app/gpui");
const action = process.argv[2] ?? "run";
const extra = process.argv.slice(3);
const artifacts = path.join(root, ".artifacts/gpui");
const localRuntimePackages = ["cli", "codegen", "core", "hermes"];
mkdirSync(artifacts, { recursive: true });

function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    cwd: project,
    stdio: "inherit",
    env: {
      ...process.env,
      PASEO_RENDERER: "gpui",
      CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? "4",
      ...env,
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function parseLocalInstallArg(args) {
  let localRepo = process.env.PASEO_GPUI_LOCAL?.trim() || "";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--local") {
      localRepo = args[++i] ?? "";
      if (!localRepo) throw new Error("--local requires a path to a react-native-gpui checkout");
    } else if (arg.startsWith("--local=")) {
      localRepo = arg.slice("--local=".length);
    } else {
      throw new Error(`Unknown gpui:install argument: ${arg}`);
    }
  }
  return localRepo ? path.resolve(localRepo) : null;
}

function installLocalRuntime(localRepo) {
  for (const name of localRuntimePackages) {
    const manifestPath = path.join(localRepo, "packages", name, "package.json");
    if (!existsSync(manifestPath)) {
      throw new Error(`Missing local package manifest: ${manifestPath}`);
    }
  }

  const stage = mkdtempSync(path.join(os.tmpdir(), "paseo-gpui-local-"));
  try {
    for (const name of localRuntimePackages) {
      const pkgDir = path.join(localRepo, "packages", name);
      const output = execFileSync("npm", ["pack", "--json", "--pack-destination", stage], {
        cwd: pkgDir,
        encoding: "utf8",
        shell: process.platform === "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const [packed] = JSON.parse(output);
      if (!packed?.filename) {
        throw new Error(`npm pack produced no tarball for local package ${name}`);
      }
      const destDir = path.join(project, "node_modules", "@react-native-gpui", name);
      rmSync(destDir, { recursive: true, force: true });
      mkdirSync(destDir, { recursive: true });
      execFileSync(
        "tar",
        ["-xzf", path.join(stage, packed.filename), "--strip-components=1", "-C", destDir],
        { stdio: "inherit" },
      );
      process.stdout.write(`Installed local @react-native-gpui/${name} from ${pkgDir}\n`);
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (action === "install") {
  const localRepo = parseLocalInstallArg(extra);
  run("npm", ["ci", "--workspaces=false"]);
  if (localRepo) installLocalRuntime(localRepo);
} else if (action === "bundle") {
  run("node", [
    "node_modules/react-native/cli.js",
    "bundle",
    "--platform",
    "desktop",
    "--entry-file",
    "index.js",
    "--config",
    "desktop/metro.config.js",
    "--bundle-output",
    path.join(root, ".artifacts/gpui/paseo.bundle"),
    "--sourcemap-output",
    path.join(artifacts, "paseo.bundle.map"),
    "--assets-dest",
    path.join(artifacts, "assets"),
    "--max-workers",
    "2",
    ...extra,
  ]);
  const map = JSON.parse(readFileSync(path.join(artifacts, "paseo.bundle.map"), "utf8"));
  const sources = map.sections
    ? map.sections.flatMap((section) => section.map.sources)
    : map.sources;
  if (sources.some((source) => source.includes("/react-native-webview/")))
    throw new Error("GPUI bundle must not include WebView modules");
  for (const route of [
    "src/app/_layout.tsx",
    "src/app/open-project.tsx",
    "src/app/h/[serverId]/workspace/[workspaceId]/index.tsx",
  ]) {
    if (!sources.some((source) => source.endsWith(route)))
      throw new Error(`GPUI bundle is missing Paseo route: ${route}`);
  }
} else if (action === "build" || action === "run") {
  run(process.execPath, [fileURLToPath(import.meta.url), "bundle", "--dev", "false"]);
  run("node", ["node_modules/@react-native-gpui/cli/bin/react-native-gpui.js", "autolink"]);
  run("cargo", [action, "--manifest-path", "desktop/Cargo.toml", ...extra], {
    RN_GPUI_AUTOLINK_MANIFEST: path.join(project, "desktop/autolink/autolink.json"),
    RN_GPUI_AUTOLINK_CMAKE: path.join(project, "desktop/autolink/autolink.cmake"),
    RN_GPUI_DEV_MODE: "0",
    RN_GPUI_ASSETS_DIR: path.join(artifacts, "assets/assets"),
    RN_GPUI_BUNDLE: path.join(root, ".artifacts/gpui/paseo.bundle"),
  });
} else {
  throw new Error(`Unknown GPUI action: ${action}`);
}
