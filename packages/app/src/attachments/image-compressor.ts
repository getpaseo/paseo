import type { CompressImageInput, EncodedAttachment } from "@/attachments/image-compression";

/**
 * Fallback compressor for environments without a platform image pipeline
 * (Node/test). Metro resolves `.web.ts` / `.native.ts` for real runtimes.
 * Returning null means "not compressed"; the caller's budget guard still applies.
 */
export async function compressImage(_input: CompressImageInput): Promise<EncodedAttachment | null> {
  return null;
}
