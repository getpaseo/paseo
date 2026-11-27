import { describe, expect, it } from "vitest";
import { base64ByteLength, toPickedImage } from "./picked-image";

describe("picked images for plugins", () => {
  it("counts decoded bytes, padding included", () => {
    expect(base64ByteLength("")).toBe(0);
    expect(base64ByteLength("YQ==")).toBe(1);
    expect(base64ByteLength("YWI=")).toBe(2);
    expect(base64ByteLength("YWJj")).toBe(3);
  });

  it("keeps what the platform reported", () => {
    expect(
      toPickedImage({
        uri: "file:///cache/IMG_1.png",
        base64: "YWJj",
        mimeType: "image/png",
        fileName: "IMG_1.png",
        width: 40,
        height: 30,
      }),
    ).toEqual({
      uri: "file:///cache/IMG_1.png",
      base64: "YWJj",
      mimeType: "image/png",
      fileName: "IMG_1.png",
      width: 40,
      height: 30,
      byteLength: 3,
    });
  });

  it("infers the type from the name when the platform omits it", () => {
    expect(
      toPickedImage({
        uri: "file:///cache/ABC.JPG",
        base64: "YQ==",
        mimeType: null,
        fileName: null,
        width: 1,
        height: 1,
      }),
    ).toEqual({
      uri: "file:///cache/ABC.JPG",
      base64: "YQ==",
      mimeType: "image/jpeg",
      width: 1,
      height: 1,
      byteLength: 1,
    });
  });

  it("drops an asset that arrived without its bytes", () => {
    expect(
      toPickedImage({ uri: "file:///cache/a.png", base64: null, width: 1, height: 1 }),
    ).toBeNull();
  });
});
