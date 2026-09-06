import { describe, expect, it } from "vitest";
import {
  getMimeTypeFromPath,
  getRasterImageMimeTypeFromPath,
  getVideoMimeTypeFromPath,
  isRasterImageFile,
  isRasterImageMimeType,
  isRasterImagePath,
  isVideoMimeType,
  isVideoPath,
  RASTER_IMAGE_FILE_EXTENSIONS,
  resolveRasterImageMimeType,
  resolveVideoMimeType,
} from "./file-types";

describe("attachment file types", () => {
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

  it("maps the video extensions a browser decodes natively", () => {
    expect(getVideoMimeTypeFromPath("/tmp/demo.mp4")).toBe("video/mp4");
    expect(getVideoMimeTypeFromPath("/tmp/demo.M4V")).toBe("video/mp4");
    expect(getVideoMimeTypeFromPath("/tmp/capture.webm?v=2")).toBe("video/webm");
    expect(getVideoMimeTypeFromPath("/tmp/clip.mov")).toBe("video/quicktime");
    expect(isVideoPath("/tmp/demo.mp4")).toBe(true);
  });

  it("leaves containers no browser plays out of the video table", () => {
    expect(getVideoMimeTypeFromPath("/tmp/demo.mkv")).toBeNull();
    expect(getVideoMimeTypeFromPath("/tmp/demo.avi")).toBeNull();
    expect(isVideoPath("/tmp/demo.mkv")).toBe(false);
    expect(isVideoMimeType("video/x-matroska")).toBe(false);
  });

  it("keeps the video table out of the generic attachment MIME path", () => {
    expect(getMimeTypeFromPath("/tmp/demo.mp4")).toBe("application/octet-stream");
    expect(isRasterImagePath("/tmp/demo.mp4")).toBe(false);
  });

  it("uses explicit video MIME metadata before the filename", () => {
    expect(resolveVideoMimeType({ mimeType: "video/webm", path: "/tmp/demo.mp4" })).toBe(
      "video/webm",
    );
    expect(resolveVideoMimeType({ mimeType: "video/mp4; codecs=avc1", path: "/x.webm" })).toBe(
      "video/mp4",
    );
    expect(
      resolveVideoMimeType({ mimeType: "application/octet-stream", path: "/tmp/demo.mp4" }),
    ).toBeNull();
    expect(resolveVideoMimeType({ mimeType: "", path: "/tmp/demo.mp4" })).toBe("video/mp4");
  });
});
