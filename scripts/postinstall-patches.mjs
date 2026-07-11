import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

// In CI we often install a single workspace (e.g. server/relay/website). Only apply patches
// when the patched dependency is actually present.
const patchedPackages = [
  {
    nodeModulesPath: "node_modules/react-native-markdown-display",
    patchPrefix: "react-native-markdown-display+",
  },
  {
    nodeModulesPath: "node_modules/react-native-draggable-flatlist",
    patchPrefix: "react-native-draggable-flatlist+",
  },
  {
    nodeModulesPath: "node_modules/react-native-gesture-handler",
    patchPrefix: "react-native-gesture-handler+",
  },
];

const installedPatchPrefixes = patchedPackages
  .filter(({ nodeModulesPath }) => existsSync(nodeModulesPath))
  .map(({ patchPrefix }) => patchPrefix);

if (!existsSync("patches") || installedPatchPrefixes.length === 0) {
  process.exit(0);
}

const patchFilesToApply = readdirSync("patches").filter(
  (file) =>
    file.endsWith(".patch") &&
    installedPatchPrefixes.some((patchPrefix) => file.startsWith(patchPrefix)),
);

if (patchFilesToApply.length === 0) {
  process.exit(0);
}

const isWindows = process.platform === "win32";
const cmd = isWindows ? "patch-package.cmd" : "patch-package";
const tempPatchDir = join(".tmp", `postinstall-patches-${process.pid}`);

mkdirSync(tempPatchDir, { recursive: true });
for (const patchFile of patchFilesToApply) {
  copyFileSync(join("patches", patchFile), join(tempPatchDir, patchFile));
}

let result;
try {
  result = spawnSync(cmd, ["--patch-dir", tempPatchDir], {
    shell: isWindows,
    stdio: "inherit",
    windowsHide: true,
  });
} finally {
  rmSync(tempPatchDir, { recursive: true, force: true });
}

process.exit(result.status ?? 1);
