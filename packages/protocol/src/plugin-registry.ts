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
/**
 * Listing text in other languages, keyed by language tag such as `zh-CN`. A missing field falls back
 * to the English `name` or `description`, which stay required so older clients keep working.
 */
export const PluginListingTranslationsSchema = z.record(
  z.string(),
  z.object({ name: z.string().optional(), description: z.string().optional() }),
);
export const PublishedPluginSchema = z.object({
  id: PluginRegistryIdSchema,
  name: z.string(),
  description: z.string(),
  translations: PluginListingTranslationsSchema.optional(),
  license: z.string().optional(),
  categories: z.array(z.string()),
  author: z.object({ github: z.string(), name: z.string().optional(), npm: z.string().optional() }),
  repository: z.object({ url: z.string().url(), commit: z.string().optional() }),
  artifact: PluginRegistryArtifactSchema,
  icon: z.string().url().optional(),
  /** Images and videos in display order; see `pluginMediaKind`. */
  media: z.array(z.string().url()),
  submittedAt: z.string(),
  reviewedAt: z.string(),
  updatedAt: z.string(),
  publishedAt: z.string(),
  installs: z.number().int().nonnegative().optional(),
});
const VIDEO_EXTENSIONS = new Set(["mp4", "webm"]);

/** Whether a registry media entry is a video or an image, from its path extension. */
export function pluginMediaKind(url: string): "image" | "video" {
  const extension = new URL(url).pathname.split(".").pop()?.toLowerCase() ?? "";
  return VIDEO_EXTENSIONS.has(extension) ? "video" : "image";
}
export const PublishedPluginDetailSchema = PublishedPluginSchema.extend({
  readme: z.string(),
  /** The overview in other languages, keyed like `translations`. Each one replaces `readme` whole. */
  overviewTranslations: z.record(z.string(), z.string()).optional(),
});
export const PluginRegistryIndexSchema = z.object({
  schemaVersion: z.literal(1),
  registry: z.object({ name: z.string(), url: z.string().url() }),
  categories: z.array(
    z.object({ slug: z.string(), label: z.string(), description: z.string().optional() }),
  ),
  plugins: z.array(PublishedPluginSchema),
  /** Plugin IDs the maintainer features, in display order. An ID may name a plugin that is not listed. */
  featured: z.array(z.string()),
  generatedAt: z.string(),
});

/**
 * A listing as a host sends it to apps. The registry's schema is closed, so its artifact is open
 * here: an app older than its host keeps listing plugins whose artifact kind it does not know, and
 * installs them through the host by ID.
 */
const PluginListingArtifactSchema = z.object({
  kind: z.string(),
  package: z.string().optional(),
  version: z.string().optional(),
  commit: z.string().optional(),
});
export const PluginListingSchema = PublishedPluginSchema.extend({
  artifact: PluginListingArtifactSchema,
});
export const PluginListingDetailSchema = PublishedPluginDetailSchema.extend({
  artifact: PluginListingArtifactSchema,
});
export const PluginListingIndexSchema = PluginRegistryIndexSchema.extend({
  schemaVersion: z.number().int(),
  plugins: z.array(PluginListingSchema),
});
export type PluginListing = z.infer<typeof PluginListingSchema>;
export type PluginListingDetail = z.infer<typeof PluginListingDetailSchema>;
export type PluginListingIndex = z.infer<typeof PluginListingIndexSchema>;

export type PluginRegistryIdentity = z.infer<typeof PluginRegistryIdentitySchema>;
export type PluginRegistries = z.infer<typeof PluginRegistriesSchema>;
export type PublishedPlugin = z.infer<typeof PublishedPluginSchema>;
export type PublishedPluginDetail = z.infer<typeof PublishedPluginDetailSchema>;
export type PluginRegistryIndex = z.infer<typeof PluginRegistryIndexSchema>;

export const DEFAULT_PLUGIN_REGISTRY_URL = "https://plugins.paseo.sh";

export function parsePluginRegistryReference(
  source: string,
  defaultUrl = DEFAULT_PLUGIN_REGISTRY_URL,
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
