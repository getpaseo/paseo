import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { PluginIdSchema, PluginRequirementsSchema } from "@getpaseo/protocol/messages";
import { validatePluginRequirements } from "@getpaseo/protocol/plugin-requirements";

const MANIFEST_FILENAME = "paseo-plugin.json";
const PluginBuildCommandSchema = z
  .array(z.string().refine((argument) => argument.trim().length > 0))
  .min(1);
// Manifest asset paths use forward slashes and stay inside the plugin package.
const PluginAssetPathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      value === value.trim() &&
      !value.startsWith("/") &&
      !/[\\:?#\p{Cc}]/u.test(value) &&
      !value.split("/").includes("..") &&
      !value.endsWith("/") &&
      value.split("/").at(-1) !== ".",
    "Expected a relative file path inside the plugin package",
  );
const PluginManifestSchema = z.object({
  id: PluginIdSchema,
  name: z.string().trim().min(1).optional(),
  description: z.string().trim().min(1).optional(),
  icon: PluginAssetPathSchema.refine(
    (value) => /\.png$/i.test(value),
    "Expected a relative path to a PNG",
  ).optional(),
  media: z.array(z.union([PluginAssetPathSchema, z.url({ protocol: /^https$/ })])).optional(),
  // A misspelled requirement must not silently disable compatibility checks.
  requirements: PluginRequirementsSchema.strict().optional(),
  build: z.array(PluginBuildCommandSchema).min(1).optional(),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export async function readPluginManifest(directory: string): Promise<PluginManifest> {
  const manifestPath = path.join(directory, MANIFEST_FILENAME);
  const info = await stat(manifestPath).catch(() => null);
  if (!info?.isFile()) throw new Error(`Plugin manifest is missing: ${manifestPath}`);
  const manifest = PluginManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
  validatePluginRequirements(manifest.requirements);
  return manifest;
}
