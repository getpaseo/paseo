import { describe, expect, it, vi } from "vitest";
import { bytesToBase64, clampByteRange, inferFileMimeType, toPickedFile } from "./picked-file";

const CONTENT = new TextEncoder().encode("hello, plugin");

function memorySource(fileName: string, mimeType?: string | null) {
  const readBytes = vi.fn(async (offset: number, length: number) =>
    CONTENT.subarray(offset, offset + length),
  );
  return {
    readBytes,
    source: { fileName, mimeType, byteLength: CONTENT.byteLength, readBytes },
  };
}

describe("picked files for plugins", () => {
  it("keeps the type the platform reported", () => {
    const { source } = memorySource("notes.txt", "text/markdown");
    expect(toPickedFile(source)).toMatchObject({
      fileName: "notes.txt",
      mimeType: "text/markdown",
      byteLength: 13,
    });
  });

  it("infers the type from the name when the platform omits it", () => {
    expect(toPickedFile(memorySource("Report.PDF", null).source).mimeType).toBe("application/pdf");
    expect(toPickedFile(memorySource("photo.jpg", "").source).mimeType).toBe("image/jpeg");
    expect(toPickedFile(memorySource("archive.bin").source).mimeType).toBe(
      "application/octet-stream",
    );
    expect(inferFileMimeType("no-extension")).toBe("application/octet-stream");
  });

  it("encodes the requested range as base64", async () => {
    const { source, readBytes } = memorySource("notes.txt", "text/plain");
    const file = toPickedFile(source);

    await expect(file.readBase64(0, 5)).resolves.toBe(bytesToBase64(CONTENT.subarray(0, 5)));
    await expect(file.readBase64(7, 6)).resolves.toBe(bytesToBase64(CONTENT.subarray(7, 13)));
    expect(readBytes).toHaveBeenNthCalledWith(1, 0, 5);
    expect(readBytes).toHaveBeenNthCalledWith(2, 7, 6);
  });

  it("returns fewer bytes at the end and none past it, without reading", async () => {
    const { source, readBytes } = memorySource("notes.txt", "text/plain");
    const file = toPickedFile(source);

    await expect(file.readBase64(10, 256)).resolves.toBe(bytesToBase64(CONTENT.subarray(10, 13)));
    expect(readBytes).toHaveBeenLastCalledWith(10, 3);
    await expect(file.readBase64(13, 256)).resolves.toBe("");
    await expect(file.readBase64(0, 0)).resolves.toBe("");
    expect(readBytes).toHaveBeenCalledTimes(1);
  });

  it("rejects a range that is not a non-negative integer pair", async () => {
    const file = toPickedFile(memorySource("notes.txt", "text/plain").source);

    await expect(file.readBase64(-1, 4)).rejects.toThrow(RangeError);
    await expect(file.readBase64(0, 1.5)).rejects.toThrow(RangeError);
    await expect(file.readBase64(Number.NaN, 4)).rejects.toThrow(RangeError);
  });

  it("rejects when the platform can no longer read the file", async () => {
    const source = {
      fileName: "gone.txt",
      mimeType: "text/plain",
      byteLength: 4,
      readBytes: async () => {
        throw new Error("File does not exist");
      },
    };

    await expect(toPickedFile(source).readBase64(0, 4)).rejects.toThrow("File does not exist");
  });

  it("clamps ranges to the file", () => {
    expect(clampByteRange(0, 10, 4)).toEqual({ offset: 0, length: 4 });
    expect(clampByteRange(2, 10, 4)).toEqual({ offset: 2, length: 2 });
    expect(clampByteRange(4, 10, 4)).toEqual({ offset: 4, length: 0 });
    expect(clampByteRange(9, 10, 4)).toEqual({ offset: 9, length: 0 });
  });

  it("encodes a view into a larger buffer by its own bytes only", () => {
    const backing = new Uint8Array([0, 0, 97, 98, 99, 0]);
    expect(bytesToBase64(backing.subarray(2, 5))).toBe("YWJj");
  });
});
