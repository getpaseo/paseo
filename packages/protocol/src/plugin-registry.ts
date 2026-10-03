import { z } from "zod";

export const PluginRegistryIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const PluginRegistryIdentitySchema = z.object({
  url: z.string().url(),
  id: PluginRegistryIdSchema,
});
export const PluginRegistriesSchema = z.record(
  z.string(),
  z.object({ authorization: z.string().min(1) }),
);
export const PluginRegistryArtifactSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("npm"),
    package: z.string().regex(/^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/),
    resolved: z.string().url(),
    integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]+=*$/),
  }),
  z.object({
    kind: z.literal("git"),
    remote: z.string().min(1),
    commit: z.string().regex(/^[0-9a-f]{40,64}$/),
    pluginPath: z
      .string()
      .regex(/^[^\\:]+$/)
      .optional(),
  }),
]);
export const PublishedPluginSchema = z.object({
  id: PluginRegistryIdSchema,
  name: z.string(),
  description: z.string(),
  license: z.string().optional(),
  categories: z.array(z.string()),
  author: z.object({ github: z.string(), name: z.string().optional(), npm: z.string().optional() }),
  repository: z.object({ url: z.string().url(), commit: z.string().optional() }),
  artifact: PluginRegistryArtifactSchema,
  icon: z.string().url().optional(),
  screenshots: z.array(z.string().url()),
  submittedAt: z.string(),
  reviewedAt: z.string(),
  updatedAt: z.string(),
  publishedAt: z.string(),
  installs: z.number().int().nonnegative().optional(),
});
export const PublishedPluginDetailSchema = PublishedPluginSchema.extend({ readme: z.string() });
export const PluginRegistryIndexSchema = z.object({
  schemaVersion: z.literal(1),
  registry: z.object({ name: z.string(), url: z.string().url() }),
  categories: z.array(
    z.object({ slug: z.string(), label: z.string(), description: z.string().optional() }),
  ),
  plugins: z.array(PublishedPluginSchema),
  generatedAt: z.string(),
});
export type PluginRegistryIdentity = z.infer<typeof PluginRegistryIdentitySchema>;
export type PluginRegistries = z.infer<typeof PluginRegistriesSchema>;

export function parsePluginRegistryReference(
  source: string,
  defaultUrl = "https://plugins.paseo.sh",
): PluginRegistryIdentity | null {
  const segments = source.split("/");
  if (segments.length === 2 && PluginRegistryIdSchema.safeParse(source).success)
    return { url: defaultUrl.replace(/\/+$/, ""), id: source };
  const [host, ...rest] = segments;
  if (segments.length !== 3 || !host || !/[.:]/.test(host) || /[@?#\\]/.test(host)) return null;
  const id = rest.join("/");
  if (!PluginRegistryIdSchema.safeParse(id).success) return null;
  const url = new URL(`https://${host}`);
  return { url: url.origin, id };
}
