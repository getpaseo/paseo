import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative } from "node:path";

// In CI we often install a single workspace (e.g. server/relay/website). Only apply patches
// when the patched dependency is actually present.
// `cwd` is where patch-package must run from. Packages that npm does not hoist to the
// workspace root live in their workspace's own node_modules, and patch-package resolves
// the patch's node_modules/... paths relative to its working directory.
const patchedPackages = [
  {
    nodeModulesPath: "packages/app/node_modules/react-native-enriched-markdown",
    patchPrefix: "react-native-enriched-markdown+",
    cwd: "packages/app",
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
  // Exports BottomSheetModalInternalProvider so a subtree can host its own sheets on the shared
  // modal stack (see packages/app/src/components/ui/isolated-bottom-sheet-modal/host-scope.tsx), and
  // keeps a dismissing modal's status through its final onChange(-1), so a modal with
  // enableDismissOnClose=false that unmounts while presented still leaves the portal.
  {
    nodeModulesPath: "node_modules/@gorhom/bottom-sheet",
    patchPrefix: "@gorhom+bottom-sheet+",
  },
  {
    nodeModulesPath: "packages/app/node_modules/react-native-svg",
    patchPrefix: "react-native-svg+",
    cwd: "packages/app",
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

const isWindows = process.platform === "win32";
const cmd = isWindows ? "patch-package.cmd" : "patch-package";

let failed = false;
for (const [index, { nodeModulesPath, patchPrefix, cwd = "." }] of installedPackages.entries()) {
  const files = patchFiles.filter((file) => file.startsWith(patchPrefix));
  if (files.length === 0) {
    continue;
  }
  const outcome = applyPatches(cwd, files, index);
  if (outcome === "applied") {
    continue;
  }
  failed = true;
  if (outcome === "unavailable") {
    continue;
  }
  // patch-package cannot apply a patch that changed after an earlier version of it was
  // applied. Without the package, the next install fetches it clean and applies the patch.
  rmSync(nodeModulesPath, { recursive: true, force: true });
  console.error(
    `postinstall-patches: removed ${nodeModulesPath} because its patch did not apply. ` +
      "Run npm install again to reinstall it with the current patch. " +
      "If it fails again on the clean package, the patch is out of date and must be regenerated.",
  );
}

process.exit(failed ? 1 : 0);

function applyPatches(cwd, files, index) {
  const tempPatchDir = join(".tmp", `postinstall-patches-${process.pid}-${index}`);
  mkdirSync(tempPatchDir, { recursive: true });
  for (const patchFile of files) {
    copyFileSync(join("patches", patchFile), join(tempPatchDir, patchFile));
  }

  let result;
  try {
    result = spawnSync(cmd, ["--patch-dir", relative(cwd, tempPatchDir), "--error-on-fail"], {
      cwd,
      shell: isWindows,
      stdio: "inherit",
      windowsHide: true,
    });
  } finally {
    rmSync(tempPatchDir, { recursive: true, force: true });
  }

  if (result.error) {
    console.error("postinstall-patches: patch-package failed to spawn:", result.error.message);
    return "unavailable";
  }
  return result.status === 0 ? "applied" : "rejected";
}
