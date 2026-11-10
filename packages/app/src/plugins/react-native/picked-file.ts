import { Buffer } from "buffer";
import type { PickedFile } from "@getpaseo/plugin/client/react-native";
import { getFileExtension, getRasterImageMimeTypeFromPath } from "@/attachments/file-types";

/** What each platform's chooser hands back, before it is a plugin `PickedFile`. */
export interface PickedFileSource {
  fileName: string;
  mimeType?: string | null;
  byteLength: number;
  /** Bytes in `[offset, offset + length)`, already clamped to the file. */
  readBytes(offset: number, length: number): Promise<Uint8Array>;
}

export interface ByteRange {
  offset: number;
  length: number;
}

const GENERIC_MIME_TYPE = "application/octet-stream";

/** Common document types; the image table lives with the attachment file types. */
const DOCUMENT_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".xml": "application/xml",
  ".html": "text/html",
  ".htm": "text/html",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".svg": "image/svg+xml",
};

export function inferFileMimeType(fileName: string): string {
  return (
    getRasterImageMimeTypeFromPath(fileName) ??
    DOCUMENT_MIME_BY_EXTENSION[getFileExtension(fileName)] ??
    GENERIC_MIME_TYPE
  );
}

/**
 * The range a plugin asked for, cut to the file. A request that starts past the end is empty
 * rather than an error, so a chunked upload loop can stop on an empty result.
 */
export function clampByteRange(offset: number, length: number, byteLength: number): ByteRange {
  if (!Number.isInteger(offset) || offset < 0)
    throw new RangeError(`offset must be a non-negative integer, got ${offset}`);
  if (!Number.isInteger(length) || length < 0)
    throw new RangeError(`length must be a non-negative integer, got ${length}`);
  const end = Math.min(byteLength, offset + length);
  return { offset, length: Math.max(0, end - offset) };
}

export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

/** Bytes stay behind a reader: a plugin reads a 50 MB file a chunk at a time, never all at once. */
export function toPickedFile(source: PickedFileSource): PickedFile {
  const { fileName, byteLength } = source;
  const mimeType = source.mimeType || inferFileMimeType(fileName);
  return {
    fileName,
    mimeType,
    byteLength,
    async readBase64(offset, length) {
      const range = clampByteRange(offset, length, byteLength);
      if (range.length === 0) return "";
      return bytesToBase64(await source.readBytes(range.offset, range.length));
    },
  };
}
