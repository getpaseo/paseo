import { describe, expect, it } from "vitest";
import type { AttachmentMetadata } from "@/attachments/types";
import {
  createAssistantImageFileAcquisition,
  type AssistantImageFileAcquisitionPort,
} from "./file-acquisition";

class MemoryFileAcquisitionPort implements AssistantImageFileAcquisitionPort {
  readonly reads: Array<{ cwd: string; path: string; maxBytes?: number }> = [];

  constructor(
    private readonly file: { kind: "image" | "binary" | "text"; mime: string } = {
      kind: "image",
      mime: "image/png",
    },
  ) {}

  async readFile(cwd: string, path: string, maxBytes?: number) {
    this.reads.push({ cwd, path, maxBytes });
    return {
      kind: this.file.kind,
      path,
      mime: this.file.mime,
      size: 4,
      modifiedAt: "1",
      bytes: new Uint8Array([1, 2, 3, 4]),
    };
  }

  async persist(input: { id: string; mimeType: string; fileName: string | null }) {
    return {
      id: input.id,
      mimeType: input.mimeType,
      storageType: "web-indexeddb" as const,
      storageKey: input.id,
      fileName: input.fileName,
      byteSize: 4,
      createdAt: 1,
    } satisfies AttachmentMetadata;
  }
}

describe("assistant image file acquisition", () => {
  it("recreates the same acquisition with a live port after reconnect", async () => {
    const common = {
      resolution: { kind: "file_rpc" as const, cwd: "/workspace", path: "reconnect.png" },
      serverId: "server",
      occurrenceKey: "agent:message:reconnect-image",
      unavailableMessage: "Image unavailable",
    };
    const disconnected = createAssistantImageFileAcquisition({ ...common, port: null });
    const connectedPort = new MemoryFileAcquisitionPort();
    const connected = createAssistantImageFileAcquisition({ ...common, port: connectedPort });

    expect(disconnected?.key).toBe(connected?.key);
    await expect(disconnected?.locate()).rejects.toThrow("Image unavailable");
    await expect(connected?.locate()).resolves.toMatchObject({ mimeType: "image/png" });
    expect(connectedPort.reads).toEqual([
      { cwd: "/workspace", path: "reconnect.png", maxBytes: undefined },
    ]);
  });

  it("rejects a read the caller cannot render", async () => {
    // A daemon that predates video MIME types reports the file as an anonymous
    // binary, and a blob built from that never plays.
    const port = new MemoryFileAcquisitionPort({
      kind: "binary",
      mime: "application/octet-stream",
    });
    const acquisition = createAssistantImageFileAcquisition({
      port,
      resolution: { kind: "file_rpc", cwd: "/workspace", path: "demo.mp4" },
      serverId: "server",
      occurrenceKey: "agent:message:video",
      unavailableMessage: "Video preview unavailable.",
      accept: (file) => file.mime.startsWith("video/"),
      maxBytes: 10,
    });

    await expect(acquisition?.locate()).rejects.toThrow("Video preview unavailable.");
  });

  it("accepts a video read and forwards the byte ceiling to the daemon", async () => {
    const port = new MemoryFileAcquisitionPort({ kind: "binary", mime: "video/mp4" });
    const acquisition = createAssistantImageFileAcquisition({
      port,
      resolution: { kind: "file_rpc", cwd: "/workspace", path: "demo.mp4" },
      serverId: "server",
      occurrenceKey: "agent:message:video",
      unavailableMessage: "Video preview unavailable.",
      accept: (file) => file.mime.startsWith("video/"),
      maxBytes: 50 * 1024 * 1024,
    });

    await expect(acquisition?.locate()).resolves.toMatchObject({
      mimeType: "video/mp4",
      fileName: "demo.mp4",
    });
    expect(port.reads).toEqual([
      { cwd: "/workspace", path: "demo.mp4", maxBytes: 50 * 1024 * 1024 },
    ]);
  });
});
