export const PROVIDER_IMAGE_ATTACHMENT_DIR = "paseo-attachments";

// Materialized provider images use content-hashed files, unlike ordinary user-authored
// image links. Accept old doubled-backslash Windows history as well as current file URIs.
const PROVIDER_IMAGE_PATTERN = `!\\[[^\\]]*\\]\\([^)]*${PROVIDER_IMAGE_ATTACHMENT_DIR}(?:-[^/\\\\)]+)?[/\\\\]+(?:[^/\\\\)]+[/\\\\]+)?[0-9a-f]{64}\\.[a-z0-9]+\\)`;
const PROVIDER_IMAGE_PREFIX = new RegExp(`^${PROVIDER_IMAGE_PATTERN}`);
const PROVIDER_IMAGES_ONLY = new RegExp(`^(?:${PROVIDER_IMAGE_PATTERN}\\s*)+$`);
const PROVIDER_IMAGES = new RegExp(PROVIDER_IMAGE_PATTERN, "g");

export function isProviderImageMarkdown(text: string): boolean {
  return PROVIDER_IMAGE_PREFIX.test(text.trimStart());
}

// Adjacent image outputs can merge into one assistant message. Prose must stay visible
// even when it follows an image that the history replay prefix check recognizes.
export function isProviderImageOnlyMarkdown(text: string): boolean {
  return PROVIDER_IMAGES_ONLY.test(text.trim());
}

/** Counts pure provider-image messages without parsing Markdown or extracting addresses. */
export function countProviderImages(text: string): number {
  if (!isProviderImageOnlyMarkdown(text)) return 0;
  return text.match(PROVIDER_IMAGES)!.length;
}
