import { describe, expect, it } from "vitest";
import {
  getMimeTypeFromPath,
  getRasterImageMimeTypeFromPath,
  isRasterImageFile,
  isRasterImageMimeType,
  isRasterImagePath,
  RASTER_IMAGE_FILE_EXTENSIONS,
  resolveRasterImageMimeType,
  resolveVideoMimeType,
} from "./file-types";

describe("attachment file types", () => {
  it.each([
    ["clip.WEBM", "video/webm"],
    ["recording.mov", "video/quicktime"],
    ["clip.mp4", "video/mp4"],
    ["clip.m4v", "video/mp4"],
    ["clip.ogv", "video/ogg"],
    ["clip.mkv", "video/x-matroska"],
    ["clip.avi", "video/x-msvideo"],
    ["clip.mpeg", "video/mpeg"],
    ["clip.mpg", "video/mpeg"],
    ["clip.3gp", "video/3gpp"],
    ["clip.3g2", "video/3gpp2"],
  ])("recognizes %s when the daemon sends generic binary MIME metadata", (path, expected) => {
    expect(resolveVideoMimeType({ path, mimeType: "application/octet-stream" })).toBe(expected);
  });

  it("honors video MIME metadata and leaves other file types alone", () => {
    expect(resolveVideoMimeType({ path: "clip", mimeType: " Video/WebM; codecs=vp9 " })).toBe(
      "video/webm",
    );
    expect(resolveVideoMimeType({ path: "clip.mp4", mimeType: "video/quicktime" })).toBe(
      "video/quicktime",
    );
    expect(resolveVideoMimeType({ path: "notes.txt", mimeType: "text/plain" })).toBeNull();
    expect(resolveVideoMimeType({ path: "archive.zip" })).toBeNull();
    expect(resolveVideoMimeType({ path: "clip.mp4.txt" })).toBeNull();
  });

  it("keeps SVG as a file while treating raster image files as images", () => {
    expect(getMimeTypeFromPath("/tmp/logo.svg")).toBe("application/octet-stream");
    expect(isRasterImagePath("/tmp/logo.svg")).toBe(false);
    expect(isRasterImageMimeType("image/svg+xml")).toBe(false);
    expect(isRasterImageFile(new File(["<svg />"], "logo.svg", { type: "image/svg+xml" }))).toBe(
      false,
    );

    expect(getRasterImageMimeTypeFromPath("/tmp/screenshot.PNG?cache=1")).toBe("image/png");
    expect(getMimeTypeFromPath("/tmp/screenshot.PNG?cache=1")).toBe("image/png");
    expect(isRasterImagePath("/tmp/screenshot.PNG?cache=1")).toBe(true);
    expect(isRasterImageMimeType("image/png; charset=binary")).toBe(true);
    expect(isRasterImageFile(new File([new Uint8Array([0])], "screenshot.png"))).toBe(true);
  });

  it("does not require MIME table entries for generic file attachments", () => {
    expect(getMimeTypeFromPath("/tmp/notes.md")).toBe("application/octet-stream");
    expect(getMimeTypeFromPath("/tmp/archive.zip")).toBe("application/octet-stream");
    expect(getMimeTypeFromPath("/tmp/report.docx")).toBe("application/octet-stream");
    expect(getMimeTypeFromPath("/tmp/runtime.log")).toBe("application/octet-stream");
    expect(getMimeTypeFromPath("/tmp/export.anything")).toBe("application/octet-stream");
  });

  it("does not offer SVG in the image picker extension list", () => {
    expect(new Set(RASTER_IMAGE_FILE_EXTENSIONS)).toEqual(
      new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "heif", "avif", "tif", "tiff"]),
    );
  });

  it("uses explicit raster MIME metadata before the filename", () => {
    expect(
      resolveRasterImageMimeType({ mimeType: "image/jpeg", path: "/tmp/screenshot.png" }),
    ).toBe("image/jpeg");
    expect(
      resolveRasterImageMimeType({
        mimeType: "image/png; charset=binary",
        path: "/tmp/screenshot.jpg",
      }),
    ).toBe("image/png");
  });

  it("uses the filename only when MIME metadata is absent", () => {
    expect(resolveRasterImageMimeType({ mimeType: "", path: "/tmp/screenshot.png" })).toBe(
      "image/png",
    );
    expect(
      resolveRasterImageMimeType({
        mimeType: "application/octet-stream",
        path: "/tmp/screenshot.png",
      }),
    ).toBeNull();
  });
});
