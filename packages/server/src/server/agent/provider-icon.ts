import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { findSvgIconProblem, PLUGIN_SVG_ICON_MAX_BYTES } from "@getpaseo/plugin";
import { resolvePaseoHome } from "../paseo-home.js";

export async function readConfiguredProviderIcon(iconPath: string): Promise<string> {
  const home = path.isAbsolute(iconPath) ? undefined : await realpath(resolvePaseoHome());
  const requested = home ? path.resolve(home, iconPath) : path.resolve(iconPath);
  if (home && !isInside(home, requested)) {
    throw new Error(`Invalid provider icon "${iconPath}": path leaves the Paseo home directory`);
  }
  const resolved = await realpath(requested);
  if (home && !isInside(home, resolved)) {
    throw new Error(`Invalid provider icon "${iconPath}": path leaves the Paseo home directory`);
  }
  const info = await stat(resolved);
  if (!info.isFile()) throw new Error(`Invalid provider icon "${iconPath}": not a regular file`);
  if (info.size > PLUGIN_SVG_ICON_MAX_BYTES)
    throw new Error(`Invalid provider icon "${iconPath}": exceeds 64 KiB`);
  const svg = await readFile(resolved, "utf8");
  const problem = findSvgIconProblem(svg);
  if (problem) throw new Error(`Invalid provider icon "${iconPath}": ${problem}`);
  return svg;
}

function isInside(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
