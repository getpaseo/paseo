/**
 * Attachment send budget + image compression contract.
 *
 * Why this exists: outbound agent messages travel as a single WebSocket frame.
 * Over the E2EE relay the image `data` field is base64 (~1.33x the raw bytes),
 * the whole JSON message is then encrypted and re-encoded as base64 by the relay
 * channel (~1.33x again), so the final frame is roughly 1.77x the raw image bytes.
 * Cloudflare closes any WebSocket frame over ~1 MiB with close code 1009
 * ("message too big"), which tears down the whole transport. A large screenshot
 * attachment therefore used to kill the session on send.
 *
 * The fix has two parts, both driven from here:
 *  1. Compress oversized images down to a byte target before encoding.
 *  2. Hard budget guard — if the encoded attachments still exceed the budget,
 *     throw {@link AttachmentTooLargeError} instead of sending, so the frame is
 *     never emitted and the socket survives.
 *
 * Budgets are expressed in base64 characters because that is exactly what lands
 * in the JSON payload. 640k base64 chars ≈ 470 KB of JSON, which stays well under
 * 1 MiB after encryption + relay base64 wrapping, leaving room for the message text.
 */

export interface EncodedAttachment {
  data: string;
  mimeType: string;
}

/** Total base64 characters allowed across all attachments in one message. */
export const MAX_TOTAL_ATTACHMENT_BASE64_CHARS = 640_000;

/** Above this per-image base64 length we attempt compression before sending. */
export const IMAGE_COMPRESS_TRIGGER_BASE64_CHARS = 480_000;

/** Byte target the compressor aims for per image (base64 of this stays comfortably under budget). */
export const IMAGE_COMPRESS_TARGET_BYTES = 320_000;

export interface CompressImageInput {
  /** Loadable URL for the source image (blob: URL on web, file:// URI on native). */
  url: string;
  mimeType: string;
  /** Target encoded size in bytes; the compressor aims at or below this. */
  targetBytes: number;
}

/** Compresses an image to (at best) `targetBytes`. Returns null if it cannot compress. */
export type ImageCompressor = (input: CompressImageInput) => Promise<EncodedAttachment | null>;

export class AttachmentTooLargeError extends Error {
  readonly totalChars: number;
  readonly limitChars: number;

  constructor(totalChars: number, limitChars: number) {
    super("Attachment is too large to send even after compression. Please attach a smaller image.");
    this.name = "AttachmentTooLargeError";
    this.totalChars = totalChars;
    this.limitChars = limitChars;
  }
}

/** Approximate decoded byte length of a base64 string (ignoring any data-URL prefix). */
export function base64Bytes(base64: string): number {
  const comma = base64.indexOf(",");
  const body =
    comma >= 0 && base64.slice(0, comma).includes(";base64") ? base64.slice(comma + 1) : base64;
  const len = body.length;
  if (len === 0) return 0;
  let padding = 0;
  if (body.endsWith("==")) padding = 2;
  else if (body.endsWith("=")) padding = 1;
  return Math.floor((len * 3) / 4) - padding;
}

/**
 * Whether an image mime type can be safely re-encoded as JPEG. We skip vector
 * (svg) and animated (gif) formats because JPEG re-encoding would destroy them.
 */
export function isCompressibleImage(mimeType: string): boolean {
  const type = mimeType.toLowerCase();
  if (!type.startsWith("image/")) return false;
  return type !== "image/gif" && type !== "image/svg+xml";
}

export interface EncodeBudgetDeps {
  encodeBase64: (attachmentId: string) => Promise<string>;
  resolvePreviewUrl: (attachmentId: string) => Promise<string>;
  releasePreviewUrl?: (attachmentId: string, url: string) => Promise<void>;
  compress: ImageCompressor;
}

export interface BudgetAttachment {
  id: string;
  mimeType: string;
}

/**
 * Encodes attachments to base64, compressing any that exceed the per-image
 * trigger, then enforces the total budget. Throws {@link AttachmentTooLargeError}
 * if the total is still over budget so the caller never sends an oversized frame.
 *
 * Per-attachment encode failures are logged and skipped (matching prior behavior);
 * only the budget guard throws.
 */
export async function encodeAttachmentsToBudget(
  attachments: readonly BudgetAttachment[],
  deps: EncodeBudgetDeps,
): Promise<EncodedAttachment[]> {
  const results: EncodedAttachment[] = [];

  for (const attachment of attachments) {
    let data: string;
    try {
      data = await deps.encodeBase64(attachment.id);
    } catch (error) {
      console.error("[attachments] Failed to encode attachment for send", {
        id: attachment.id,
        error,
      });
      continue;
    }

    let mimeType = attachment.mimeType;

    if (
      data.length > IMAGE_COMPRESS_TRIGGER_BASE64_CHARS &&
      isCompressibleImage(attachment.mimeType)
    ) {
      const url = await deps.resolvePreviewUrl(attachment.id);
      try {
        const compressed = await deps.compress({
          url,
          mimeType: attachment.mimeType,
          targetBytes: IMAGE_COMPRESS_TARGET_BYTES,
        });
        if (compressed && compressed.data.length < data.length) {
          data = compressed.data;
          mimeType = compressed.mimeType;
        }
      } catch (error) {
        console.warn("[attachments] Image compression failed; sending original", {
          id: attachment.id,
          error,
        });
      } finally {
        await deps.releasePreviewUrl?.(attachment.id, url);
      }
    }

    results.push({ data, mimeType });
  }

  const totalChars = results.reduce((sum, entry) => sum + entry.data.length, 0);
  if (totalChars > MAX_TOTAL_ATTACHMENT_BASE64_CHARS) {
    throw new AttachmentTooLargeError(totalChars, MAX_TOTAL_ATTACHMENT_BASE64_CHARS);
  }

  return results;
}
