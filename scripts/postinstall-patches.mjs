import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

// In CI we often install a single workspace (e.g. server/relay/website). Only apply patches
// when the patched dependency is actually present.
const hasDraggableFlatlist = existsSync("node_modules/react-native-draggable-flatlist");
if (!hasDraggableFlatlist) {
  process.exit(0);
}

const cmd = process.platform === "win32" ? "patch-package.cmd" : "patch-package";
const result = spawnSync(cmd, { stdio: "inherit" });
process.exit(result.status ?? 1);

