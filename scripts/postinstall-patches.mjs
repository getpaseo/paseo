import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";

// In CI we often install a single workspace (e.g. server/relay/website). Only apply patches
// when the patched dependency is actually present.
// `cwd` is where patch-package must run from. Packages that npm does not hoist to the
// workspace root live in their workspace's own node_modules, and patch-package resolves
// the patch's node_modules/... paths relative to its working directory.
const patchedPackages = [
  {
    nodeModulesPath: "node_modules/react-native-markdown-display",
    patchPrefix: "react-native-markdown-display+",
  },
  {
    nodeModulesPath: "node_modules/react-native",
    patchPrefix: "react-native+",
  },
  // Remove after react-native-unistyles ships
  // https://github.com/jpudysz/react-native-unistyles/pull/1203.
  {
    nodeModulesPath: "node_modules/react-native-unistyles",
    patchPrefix: "react-native-unistyles+",
  },
  {
    nodeModulesPath: "node_modules/react-native-draggable-flatlist",
    patchPrefix: "react-native-draggable-flatlist+",
  },
  {
    nodeModulesPath: "node_modules/react-native-gesture-handler",
    patchPrefix: "react-native-gesture-handler+",
  },
  {
    nodeModulesPath: "node_modules/react-native-svg",
    patchPrefix: "react-native-svg+",
  },
  {
    nodeModulesPath: "node_modules/@mattermost/react-native-paste-input",
    patchPrefix: "@mattermost+react-native-paste-input+",
  },
  {
    nodeModulesPath: "packages/server/node_modules/@opencode-ai/sdk",
    patchPrefix: "@opencode-ai+sdk+",
    cwd: "packages/server",
  },
];

const installedPackages = patchedPackages.filter(({ nodeModulesPath }) =>
  existsSync(nodeModulesPath),
);

if (!existsSync("patches") || installedPackages.length === 0) {
  process.exit(0);
}

const patchFiles = readdirSync("patches").filter((file) => file.endsWith(".patch"));

// Group patch files by the directory patch-package must run from.
const patchFilesByCwd = new Map();
for (const { patchPrefix, cwd = "." } of installedPackages) {
  const files = patchFiles.filter((file) => file.startsWith(patchPrefix));
  if (files.length === 0) {
    continue;
  }
  const group = patchFilesByCwd.get(cwd) ?? [];
  group.push(...files);
  patchFilesByCwd.set(cwd, group);
}

if (patchFilesByCwd.size === 0) {
  process.exit(0);
}

// Resolve the real entrypoint instead of spawning `patch-package` off PATH: npm only puts
// node_modules/.bin on PATH for its own lifecycle scripts, and the .cmd/.ps1 shims make the
// bare-name spawn platform-dependent.
function resolvePatchPackageEntry() {
  const require = createRequire(import.meta.url);
  let manifestPath;
  try {
    manifestPath = require.resolve("patch-package/package.json");
  } catch {
    return undefined;
  }
  const { bin } = JSON.parse(readFileSync(manifestPath, "utf8"));
  const binPath = typeof bin === "string" ? bin : bin?.["patch-package"];
  return binPath === undefined ? undefined : join(dirname(manifestPath), binPath);
}

const patchPackageEntry = resolvePatchPackageEntry();

if (patchPackageEntry === undefined) {
  console.error(
    "postinstall-patches: installed dependencies require patches, but patch-package is not installed.\n" +
      "  Refusing to continue with unpatched dependencies. Reinstall with dev dependencies\n" +
      "  (`npm ci --include=dev`). Note that npm treats an ambient NODE_ENV=production as\n" +
      "  --omit=dev, which drops patch-package from the install.",
  );
  process.exit(1);
}

let groupIndex = 0;
for (const [cwd, files] of patchFilesByCwd) {
  groupIndex += 1;
  const tempPatchDir = join(".tmp", `postinstall-patches-${process.pid}-${groupIndex}`);

  mkdirSync(tempPatchDir, { recursive: true });
  for (const patchFile of files) {
    copyFileSync(join("patches", patchFile), join(tempPatchDir, patchFile));
  }

  let result;
  try {
    result = spawnSync(
      process.execPath,
      [patchPackageEntry, "--patch-dir", relative(cwd, tempPatchDir)],
      {
        cwd,
        stdio: "inherit",
        windowsHide: true,
      },
    );
  } finally {
    rmSync(tempPatchDir, { recursive: true, force: true });
  }

  if (result.error) {
    console.error("postinstall-patches: patch-package failed to spawn:", result.error.message);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

process.exit(0);
