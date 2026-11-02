import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { cpSync, mkdirSync, readFileSync } from "node:fs";

const root = fileURLToPath(new URL("..", import.meta.url));
const project = path.join(root, "packages/app/gpui");
const action = process.argv[2] ?? "run";
const extra = process.argv.slice(3);
const artifacts = path.join(root, ".artifacts/gpui");
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
if (action === "install") {
  run("npm", ["install", "--workspaces=false"]);
  // npm copies file: packages. Refresh vendored source even when its version
  // did not change, so edits to the native renderer reach the next Cargo build.
  const manifest = JSON.parse(readFileSync(path.join(project, "package.json"), "utf8"));
  for (const [name, spec] of Object.entries({
    ...manifest.dependencies,
    ...manifest.devDependencies,
  })) {
    if (spec.startsWith("file:"))
      cpSync(path.resolve(project, spec.slice(5)), path.join(project, "node_modules", name), {
        recursive: true,
        preserveTimestamps: true,
      });
  }
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
