import { describe, expect, it } from "vitest";
import {
  appendDroppedFilePathText,
  extractDroppedFilePaths,
  getDroppedImageMimeType,
  resolveDroppedFilePaths,
} from "./file-drop-paths";

function dataTransfer(files: File[]): DataTransfer {
  return { files } as unknown as DataTransfer;
}

function fakeFile(input: { name: string; legacyPath?: string }): File {
  const file = { name: input.name } as unknown as File;
  if (input.legacyPath !== undefined) {
    Object.defineProperty(file, "path", {
      configurable: true,
      value: input.legacyPath,
    });
  }
  return file;
}

describe("file drop paths", () => {
  it("extracts absolute paths through Electron webUtils", () => {
    const file = fakeFile({ name: "notes.md" });
    const bridge = {
      webUtils: {
        getPathForFile: () => "/Users/me/Desktop/notes.md",
      },
    };

    expect(extractDroppedFilePaths(dataTransfer([file]), bridge)).toEqual([
      "/Users/me/Desktop/notes.md",
    ]);
  });

  it("falls back to legacy Electron file paths", () => {
    const file = fakeFile({ name: "notes.md", legacyPath: "/tmp/notes.md" });
    const bridge = {
      webUtils: {
        getPathForFile: () => {
          throw new Error("not available");
        },
      },
    };

    expect(extractDroppedFilePaths(dataTransfer([file]), bridge)).toEqual(["/tmp/notes.md"]);
  });

  it("splits image paths from other file paths", () => {
    expect(
      resolveDroppedFilePaths([
        "/Users/me/Desktop/photo.PNG",
        "/Users/me/Desktop/notes.md",
        "/Users/me/Desktop/archive.tar.gz",
        "/Users/me/Desktop/vector.svg?cache=1",
      ]),
    ).toEqual({
      imagePaths: ["/Users/me/Desktop/photo.PNG", "/Users/me/Desktop/vector.svg?cache=1"],
      textPaths: ["/Users/me/Desktop/notes.md", "/Users/me/Desktop/archive.tar.gz"],
      text: "/Users/me/Desktop/notes.md\n/Users/me/Desktop/archive.tar.gz",
    });
  });

  it("returns null text when every dropped path is an image", () => {
    expect(resolveDroppedFilePaths(["/tmp/a.jpg", "/tmp/b.webp"])).toEqual({
      imagePaths: ["/tmp/a.jpg", "/tmp/b.webp"],
      textPaths: [],
      text: null,
    });
  });

  it("resolves image mime types from path extensions", () => {
    expect(getDroppedImageMimeType("/tmp/photo.avif")).toBe("image/avif");
    expect(getDroppedImageMimeType("/tmp/unknown")).toBe("image/jpeg");
  });

  it("appends dropped path text to the existing composer text", () => {
    expect(
      appendDroppedFilePathText({
        currentText: "Please inspect",
        droppedText: "/tmp/report.pdf\n/tmp/source.ts",
      }),
    ).toBe("Please inspect\n/tmp/report.pdf\n/tmp/source.ts");

    expect(
      appendDroppedFilePathText({
        currentText: "Please inspect ",
        droppedText: "/tmp/report.pdf",
      }),
    ).toBe("Please inspect /tmp/report.pdf");

    expect(
      appendDroppedFilePathText({
        currentText: "",
        droppedText: "/tmp/report.pdf",
      }),
    ).toBe("/tmp/report.pdf");
  });
});
