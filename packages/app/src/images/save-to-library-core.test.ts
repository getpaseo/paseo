import { describe, expect, it } from "vitest";
import {
  type CopyImageInput,
  type DownloadImageInput,
  ImageLibraryPermissionError,
  type MoveImageInput,
  saveImageToLibraryWithPort,
  type ImageLibraryPort,
  type WriteBase64ImageInput,
} from "./save-to-library-core";

class TestImageLibraryPort implements ImageLibraryPort {
  readonly operations: string[] = [];
  readonly deleteErrorUris = new Set<string>();
  requiresWritePermission = true;
  isLibraryAvailable = true;
  isPermissionGranted = true;
  copyError: Error | null = null;
  downloadError: Error | null = null;
  downloadHeaders: Readonly<Record<string, string>> | undefined;
  downloadMimeType: string | null = "image/png";
  moveError: Error | null = null;
  saveError: Error | null = null;
  writeError: Error | null = null;
  private temporaryFileNumber = 0;

  async isAvailable(): Promise<boolean> {
    this.operations.push("check-availability");
    return this.isLibraryAvailable;
  }

  async requestWritePermission(): Promise<boolean> {
    this.operations.push("request-permission");
    return this.isPermissionGranted;
  }

  createTemporaryUri(extension: string): string {
    this.temporaryFileNumber += 1;
    const uri = `file:///cache/image-${this.temporaryFileNumber}.${extension}`;
    this.operations.push(`create:${uri}`);
    return uri;
  }

  async downloadImage(input: DownloadImageInput) {
    this.operations.push(`download:${input.uri}->${input.targetUri}`);
    if (this.downloadError) {
      throw this.downloadError;
    }
    return {
      uri: input.targetUri,
      mimeType: this.downloadMimeType,
      headers: this.downloadHeaders,
    };
  }

  async moveImage(input: MoveImageInput): Promise<void> {
    this.operations.push(`move:${input.from}->${input.to}`);
    if (this.moveError) {
      throw this.moveError;
    }
  }

  async copyImage(input: CopyImageInput): Promise<void> {
    this.operations.push(`copy:${input.from}->${input.to}`);
    if (this.copyError) {
      throw this.copyError;
    }
  }

  async writeBase64Image(input: WriteBase64ImageInput): Promise<void> {
    this.operations.push(`write-base64:${input.base64}->${input.uri}`);
    if (this.writeError) {
      throw this.writeError;
    }
  }

  async deleteImage(uri: string): Promise<void> {
    this.operations.push(`delete:${uri}`);
    if (this.deleteErrorUris.has(uri)) {
      throw new Error(`Delete failed: ${uri}`);
    }
  }

  async saveToLibrary(uri: string): Promise<void> {
    this.operations.push(`save:${uri}`);
    if (this.saveError) {
      throw this.saveError;
    }
  }
}

describe("saveImageToLibraryWithPort", () => {
  it("downloads a remote image, saves it to Photos, and removes temporary files", async () => {
    const port = new TestImageLibraryPort();

    await saveImageToLibraryWithPort({ uri: "https://example.com/generated-image" }, port);

    expect(port.operations).toEqual([
      "check-availability",
      "request-permission",
      "create:file:///cache/image-1.download",
      "download:https://example.com/generated-image->file:///cache/image-1.download",
      "create:file:///cache/image-2.png",
      "move:file:///cache/image-1.download->file:///cache/image-2.png",
      "delete:file:///cache/image-1.download",
      "save:file:///cache/image-2.png",
      "delete:file:///cache/image-2.png",
    ]);
  });

  it("uses a case-insensitive download content type when the URL has no extension", async () => {
    const port = new TestImageLibraryPort();
    port.downloadMimeType = null;
    port.downloadHeaders = { "Content-Type": "image/webp; charset=binary" };

    await saveImageToLibraryWithPort({ uri: "https://example.com/generated-image" }, port);

    expect(port.operations).toContain("create:file:///cache/image-2.webp");
    expect(port.operations).toContain(
      "move:file:///cache/image-1.download->file:///cache/image-2.webp",
    );
  });

  it("does not read the image when Photos permission is denied", async () => {
    const port = new TestImageLibraryPort();
    port.isPermissionGranted = false;

    await expect(
      saveImageToLibraryWithPort({ uri: "https://example.com/image.png" }, port),
    ).rejects.toBeInstanceOf(ImageLibraryPermissionError);
    expect(port.operations).toEqual(["check-availability", "request-permission"]);
  });

  it("does not request permission when the platform does not require it", async () => {
    const port = new TestImageLibraryPort();
    port.requiresWritePermission = false;

    await saveImageToLibraryWithPort({ uri: "file:///cache/generated.png" }, port);

    expect(port.operations).toEqual(["check-availability", "save:file:///cache/generated.png"]);
  });

  it("saves an existing local image without making a temporary copy", async () => {
    const port = new TestImageLibraryPort();

    await saveImageToLibraryWithPort(
      { uri: "file:///cache/generated.webp", mimeType: "image/webp" },
      port,
    );

    expect(port.operations).toEqual([
      "check-availability",
      "request-permission",
      "save:file:///cache/generated.webp",
    ]);
  });

  it("materializes a data image with its declared type before saving", async () => {
    const port = new TestImageLibraryPort();

    await saveImageToLibraryWithPort(
      {
        uri: "data:image/png;base64,AAECAw==",
        mimeType: "image/jpeg",
      },
      port,
    );

    expect(port.operations).toEqual([
      "check-availability",
      "request-permission",
      "create:file:///cache/image-1.png",
      "write-base64:AAECAw==->file:///cache/image-1.png",
      "save:file:///cache/image-1.png",
      "delete:file:///cache/image-1.png",
    ]);
  });

  it.each([
    ["image/avif", "avif"],
    ["image/bmp", "bmp"],
    ["image/tiff; charset=binary", "tiff"],
  ])("preserves supported %s data images with a .%s file", async (mimeType, extension) => {
    const port = new TestImageLibraryPort();

    await saveImageToLibraryWithPort({ uri: `data:${mimeType};base64,AAECAw==` }, port);

    expect(port.operations).toContain(`create:file:///cache/image-1.${extension}`);
    expect(port.operations).toContain(`save:file:///cache/image-1.${extension}`);
  });

  it("does not pass malformed data images to the file-system copy path", async () => {
    const port = new TestImageLibraryPort();

    await expect(
      saveImageToLibraryWithPort({ uri: "data:image/png,not-base64" }, port),
    ).rejects.toThrow("Attachment data URL is not base64 encoded.");
    expect(port.operations).toEqual(["check-availability", "request-permission"]);
  });

  it("removes a materialized image when saving to the library fails", async () => {
    const port = new TestImageLibraryPort();
    port.saveError = new Error("Photos write failed");
    port.deleteErrorUris.add("file:///cache/image-1.png");

    await expect(
      saveImageToLibraryWithPort({ uri: "data:image/png;base64,AAECAw==" }, port),
    ).rejects.toThrow("Photos write failed");
    expect(port.operations.at(-1)).toBe("delete:file:///cache/image-1.png");
  });

  it("does not report a failed save when only temporary cleanup fails", async () => {
    const port = new TestImageLibraryPort();
    port.deleteErrorUris.add("file:///cache/image-1.png");

    await expect(
      saveImageToLibraryWithPort({ uri: "data:image/png;base64,AAECAw==" }, port),
    ).resolves.toBeUndefined();
    expect(port.operations.slice(-2)).toEqual([
      "save:file:///cache/image-1.png",
      "delete:file:///cache/image-1.png",
    ]);
  });

  it("removes a partial data image when writing it fails", async () => {
    const port = new TestImageLibraryPort();
    port.writeError = new Error("Base64 write failed");

    await expect(
      saveImageToLibraryWithPort({ uri: "data:image/png;base64,AAECAw==" }, port),
    ).rejects.toThrow("Base64 write failed");
    expect(port.operations.at(-1)).toBe("delete:file:///cache/image-1.png");
  });

  it("removes a partial download when downloading fails", async () => {
    const port = new TestImageLibraryPort();
    port.downloadError = new Error("Download failed");

    await expect(
      saveImageToLibraryWithPort({ uri: "https://example.com/image.png" }, port),
    ).rejects.toThrow("Download failed");
    expect(port.operations.at(-1)).toBe("delete:file:///cache/image-1.download");
  });

  it("removes both temporary paths when moving a download fails", async () => {
    const port = new TestImageLibraryPort();
    port.moveError = new Error("Move failed");
    port.deleteErrorUris.add("file:///cache/image-1.download");

    await expect(
      saveImageToLibraryWithPort({ uri: "https://example.com/image.png" }, port),
    ).rejects.toThrow("Move failed");
    expect(port.operations.slice(-2)).toEqual([
      "delete:file:///cache/image-1.download",
      "delete:file:///cache/image-2.png",
    ]);
  });

  it("removes a partial copy when copying a local image fails", async () => {
    const port = new TestImageLibraryPort();
    port.copyError = new Error("Copy failed");

    await expect(
      saveImageToLibraryWithPort({ uri: "content://media/external/images/1" }, port),
    ).rejects.toThrow("Copy failed");
    expect(port.operations.at(-1)).toBe("delete:file:///cache/image-1.jpg");
  });
});
