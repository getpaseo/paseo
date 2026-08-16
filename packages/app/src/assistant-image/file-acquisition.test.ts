import { describe, expect, it } from "vitest";
import type { AttachmentMetadata } from "@/attachments/types";
import {
  createAssistantImageFileAcquisition,
  type AssistantImageFileAcquisitionPort,
} from "./file-acquisition";

class MemoryFileAcquisitionPort implements AssistantImageFileAcquisitionPort {
  readonly reads: Array<{ cwd: string; path: string; workspaceId?: string }> = [];

  async readFile(cwd: string, path: string, workspaceId?: string) {
    this.reads.push({ cwd, path, ...(workspaceId ? { workspaceId } : {}) });
    return {
      kind: "image" as const,
      path,
      mime: "image/png",
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
      workspaceId: "workspace-selected",
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
      { cwd: "/workspace", path: "reconnect.png", workspaceId: "workspace-selected" },
    ]);
  });

  it("keeps legacy file acquisition cwd-compatible when workspaceId is absent", async () => {
    const port = new MemoryFileAcquisitionPort();
    const acquisition = createAssistantImageFileAcquisition({
      port,
      resolution: { kind: "file_rpc", cwd: "/legacy", path: "preview.png" },
      serverId: "server",
      occurrenceKey: "agent:message:legacy-image",
      unavailableMessage: "Image unavailable",
    });

    await acquisition?.locate();

    expect(port.reads).toEqual([{ cwd: "/legacy", path: "preview.png" }]);
  });
});
