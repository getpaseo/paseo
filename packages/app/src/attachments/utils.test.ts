import { describe, expect, it } from "vitest";
import { createImageSourceCacheKey, parseDataUrl, parseImageDataUrl, pathToFileUri } from "./utils";

describe("pathToFileUri", () => {
  it("converts POSIX absolute paths to file URIs", () => {
    expect(pathToFileUri("/home/user/file.txt")).toBe("file:///home/user/file.txt");
  });

  it("converts Windows drive-letter paths to file URIs", () => {
    expect(pathToFileUri("C:\\Users\\file.txt")).toBe("file:///C:/Users/file.txt");
  });

  it("converts UNC paths to host-based file URIs", () => {
    expect(pathToFileUri("\\\\server\\share\\dir")).toBe("file://server/share/dir");
  });

  it("passes through file URIs unchanged", () => {
    expect(pathToFileUri("file:///already/uri")).toBe("file:///already/uri");
  });

  it("passes through relative paths unchanged", () => {
    expect(pathToFileUri("relative/path")).toBe("relative/path");
  });
});

describe("parseDataUrl", () => {
  it("accepts base64 data URLs with media-type parameters", () => {
    expect(parseDataUrl("data:image/png;charset=utf-8;name=preview;base64,AAECAw==")).toEqual({
      mimeType: "image/png",
      base64: "AAECAw==",
    });
  });

  it("rejects non-base64 data URLs", () => {
    expect(() => parseDataUrl("data:image/png,not-base64")).toThrow(
      "Attachment data URL is not base64 encoded.",
    );
  });
});

describe("parseImageDataUrl", () => {
  it("returns a compact cache key for image data URLs", () => {
    const dataUrl = `data:image/png;base64,${"a".repeat(512)}`;

    expect(parseImageDataUrl(dataUrl)).toMatchObject({
      mimeType: "image/png",
      base64: "a".repeat(512),
    });
    expect(createImageSourceCacheKey(dataUrl)).toMatch(/^data-image:image\/png:512:/);
    expect(createImageSourceCacheKey(dataUrl)).not.toContain("a".repeat(128));
  });

  it("ignores non-image data URLs", () => {
    expect(parseImageDataUrl("data:text/plain;base64,SGVsbG8=")).toBeNull();
  });
});
