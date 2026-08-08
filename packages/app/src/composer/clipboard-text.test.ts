import { describe, expect, it } from "vitest";
import {
  createAutomaticPastedTextFile,
  createPastedTextFile,
  PASTED_TEXT_FILE_NAME,
  PASTED_TEXT_MIME_TYPE,
  PASTED_TEXT_UPLOAD_THRESHOLD_BYTES,
  restoreFailedPastedText,
} from "./clipboard-text";

const encoder = new TextEncoder();

describe("pasted text attachments", () => {
  it("leaves short text in the composer during automatic paste", () => {
    expect(
      createAutomaticPastedTextFile("a".repeat(PASTED_TEXT_UPLOAD_THRESHOLD_BYTES - 1)),
    ).toBeNull();
  });

  it("creates a text attachment at the automatic UTF-8 byte threshold", () => {
    const text = "a".repeat(PASTED_TEXT_UPLOAD_THRESHOLD_BYTES);

    expect(createAutomaticPastedTextFile(text)).toEqual({
      fileName: PASTED_TEXT_FILE_NAME,
      mimeType: PASTED_TEXT_MIME_TYPE,
      bytes: encoder.encode(text),
    });
  });

  it("allows explicit text attachments below the automatic threshold", () => {
    expect(createPastedTextFile("short text")).toEqual({
      fileName: PASTED_TEXT_FILE_NAME,
      mimeType: PASTED_TEXT_MIME_TYPE,
      bytes: encoder.encode("short text"),
    });
  });

  it("measures Unicode content by UTF-8 byte size", () => {
    const text = "€".repeat(Math.ceil(PASTED_TEXT_UPLOAD_THRESHOLD_BYTES / 3));

    expect(text.length).toBeLessThan(PASTED_TEXT_UPLOAD_THRESHOLD_BYTES);
    expect(createAutomaticPastedTextFile(text)?.bytes).toEqual(encoder.encode(text));
  });

  it("preserves whitespace and line endings without a BOM", () => {
    const prefix = " \r\n\t";
    const text = `${prefix}${"a".repeat(PASTED_TEXT_UPLOAD_THRESHOLD_BYTES)}`;
    const result = createPastedTextFile(text);

    expect(result?.bytes).toEqual(encoder.encode(text));
    expect(result?.bytes.slice(0, 3)).not.toEqual(new Uint8Array([0xef, 0xbb, 0xbf]));
  });

  it("restores failed paste by replacing the original selection", () => {
    expect(
      restoreFailedPastedText({
        currentText: "before selection after",
        initialText: "before selection after",
        pastedText: "pasted",
        selectionStart: 7,
        selectionEnd: 16,
      }),
    ).toBe("before pasted after");
  });

  it("appends failed paste after a draft changed during upload", () => {
    expect(
      restoreFailedPastedText({
        currentText: "user typed while uploading",
        initialText: "before",
        pastedText: "pasted",
        selectionStart: 6,
        selectionEnd: 6,
      }),
    ).toBe("user typed while uploadingpasted");
  });

  it("preserves recovery text after a paste listener restart", () => {
    expect(
      restoreFailedPastedText({
        currentText: "before user edit selection after",
        initialText: "before selection after",
        pastedText: "pasted",
        selectionStart: 7,
        selectionEnd: 16,
      }),
    ).toBe("before user edit selection afterpasted");
  });
});
