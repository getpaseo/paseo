import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

// The plugin list carries the icon inline, so a huge file would ride on every list request.
export const MAX_MANIFEST_ICON_BYTES = 256 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The manifest's PNG icon as a data URL, so any client can draw it without reaching the plugin's
 * files. Undefined when the file is missing, leaves the package, is too large or is not a PNG:
 * the list still shows the plugin, with its initial in place of the icon.
 */
export async function readPluginManifestIcon(
  pluginDirectory: string,
  iconPath: string,
): Promise<string | undefined> {
  const directory = await realpath(path.resolve(pluginDirectory)).catch(() => null);
  if (!directory) return undefined;
  const icon = await realpath(path.resolve(directory, iconPath)).catch(() => null);
  if (!icon || !isInside(directory, icon)) return undefined;
  const info = await stat(icon).catch(() => null);
  if (!info?.isFile() || info.size > MAX_MANIFEST_ICON_BYTES) return undefined;
  const bytes = await readFile(icon).catch(() => null);
  if (!bytes || bytes.length > MAX_MANIFEST_ICON_BYTES) return undefined;
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return undefined;
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

function isInside(directory: string, file: string): boolean {
  const relative = path.relative(directory, file);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}
