import { PDF_MIME_TYPE } from "./pdf-mime";

/**
 * Wraps PDF bytes in a blob URL for the browser's own viewer to load.
 *
 * The mime type is not cosmetic: it is the only thing that tells the browser to
 * hand the resource to its PDF viewer rather than download it.
 */
export function createPdfObjectUrl(bytes: Uint8Array): string {
  // Copied into a fresh buffer: the caller's view may be a subarray of a larger
  // read buffer, and Blob would otherwise capture the whole thing.
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return URL.createObjectURL(new Blob([buffer], { type: PDF_MIME_TYPE }));
}

export function revokePdfObjectUrl(url: string): void {
  URL.revokeObjectURL(url);
}
