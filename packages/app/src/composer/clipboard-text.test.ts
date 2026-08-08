import { describe, expect, it } from "vitest";
import {
  createPastedTextFile,
  PASTED_TEXT_FILE_NAME,
  PASTED_TEXT_MIME_TYPE,
  PASTED_TEXT_UPLOAD_THRESHOLD_BYTES,
} from "./clipboard-text";

const encoder = new TextEncoder();

describe("createPastedTextFile", () => {
  it("leaves short text in the composer", () => {
    expect(createPastedTextFile("a".repeat(PASTED_TEXT_UPLOAD_THRESHOLD_BYTES - 1))).toBeNull();
  });

  it("creates a text attachment at the UTF-8 byte threshold", () => {
    const text = "a".repeat(PASTED_TEXT_UPLOAD_THRESHOLD_BYTES);

    expect(createPastedTextFile(text)).toEqual({
      fileName: PASTED_TEXT_FILE_NAME,
      mimeType: PASTED_TEXT_MIME_TYPE,
      bytes: encoder.encode(text),
    });
  });

  it("measures Unicode content by UTF-8 byte size", () => {
    const text = "€".repeat(Math.ceil(PASTED_TEXT_UPLOAD_THRESHOLD_BYTES / 3));

    expect(text.length).toBeLessThan(PASTED_TEXT_UPLOAD_THRESHOLD_BYTES);
    expect(createPastedTextFile(text)?.bytes).toEqual(encoder.encode(text));
  });

  it("preserves whitespace and line endings without a BOM", () => {
    const prefix = " \r\n\t";
    const text = `${prefix}${"a".repeat(PASTED_TEXT_UPLOAD_THRESHOLD_BYTES)}`;
    const result = createPastedTextFile(text);

    expect(result?.bytes).toEqual(encoder.encode(text));
    expect(result?.bytes.slice(0, 3)).not.toEqual(new Uint8Array([0xef, 0xbb, 0xbf]));
  });
});
