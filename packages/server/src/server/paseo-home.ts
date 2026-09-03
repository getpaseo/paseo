import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolvePaseoPaths, XDG_LAYOUT_MARKER } from "./paseo-paths.js";
import { ensurePrivateDirectory, writePrivateFileAtomicSync } from "./private-files.js";

/**
 * The historical single-root accessor, kept so unclassified call sites keep working. Under the
 * flat layout this is the same directory it always was; under XDG it is the data root.
 * Prefer `resolvePaseoPaths` and name the category the file actually belongs to.
 *
 * Creating the directory stays here rather than in the resolver: callers have always been able to
 * assume this one exists, while resolving a path should not be what brings a directory into being.
 */
export function resolvePaseoHome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDirectory: string = os.homedir(),
): string {
  const paths = resolvePaseoPaths(env, platform, homeDirectory);
  const home = paths.home;
  ensurePrivateDirectory(home);
  if (paths.layout === "xdg") {
    const markerPath = path.join(home, XDG_LAYOUT_MARKER);
    if (!existsSync(markerPath)) {
      writePrivateFileAtomicSync(markerPath, "1\n");
    }
  }
  return home;
}
