import { describe, expect, it } from "vitest";
import { resolveObjectURL } from "node:buffer";
import { PDF_MIME_TYPE } from "./pdf-mime";
import { createPdfObjectUrl, revokePdfObjectUrl } from "./pdf-object-url";

describe("createPdfObjectUrl", () => {
  it("types the blob as a PDF so the browser opens its viewer instead of downloading", async () => {
    const url = createPdfObjectUrl(new Uint8Array([0x25, 0x50, 0x44, 0x46]));

    const blob = resolveObjectURL(url);
    expect(blob?.type).toBe(PDF_MIME_TYPE);
    expect(await blob?.text()).toBe("%PDF");

    revokePdfObjectUrl(url);
  });

  it("copies out of a subarray rather than capturing the whole read buffer", async () => {
    const readBuffer = new Uint8Array([0, 0, 0x25, 0x50, 0x44, 0x46, 0, 0]);
    const url = createPdfObjectUrl(readBuffer.subarray(2, 6));

    const blob = resolveObjectURL(url);
    expect(blob?.size).toBe(4);
    expect(await blob?.text()).toBe("%PDF");

    revokePdfObjectUrl(url);
  });

  it("releases the url so the bytes can be collected", () => {
    const url = createPdfObjectUrl(new Uint8Array([1, 2, 3]));
    expect(resolveObjectURL(url)).toBeDefined();

    revokePdfObjectUrl(url);

    expect(resolveObjectURL(url)).toBeUndefined();
  });
});
