import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { PluginIdSchema } from "@getpaseo/protocol/messages";

const MANIFEST_FILENAME = "paseo-plugin.json";
const PluginManifestSchema = z.object({ id: PluginIdSchema }).strict();

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export async function readPluginManifest(directory: string): Promise<PluginManifest> {
  const manifestPath = path.join(directory, MANIFEST_FILENAME);
  const info = await stat(manifestPath).catch(() => null);
  if (!info?.isFile()) throw new Error(`Plugin manifest is missing: ${manifestPath}`);
  return PluginManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
}
