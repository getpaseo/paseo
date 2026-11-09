import { describe, expect, it } from "vitest";
import type { AttachmentMetadata, UserComposerAttachment } from "@/attachments/types";
import type { DraftInput } from "@/stores/draft-store/state";
import { deliverShare, type DeliverShareDeps } from "./deliver";
import type { IncomingShare, SharedFile } from "./model";

type FileAttachment = Extract<UserComposerAttachment, { kind: "file" }>;

class FakeDeliveryHost implements DeliverShareDeps {
  readonly drafts: Array<{ draftKey: string; addition: DraftInput }> = [];
  readonly opened: unknown[] = [];
  readonly retained = new Set<string>();
  readonly uploadedTo: string[] = [];
  uploadError: Error | null = null;

  rasterImageMimeType(file: SharedFile): string | null {
    return file.mimeType.startsWith("image/") ? file.mimeType : null;
  }

  async persistImage(file: SharedFile, mimeType: string): Promise<AttachmentMetadata> {
    return {
      id: `image:${file.name}`,
      mimeType,
      storageType: "native-file",
      storageKey: `/attachments/${file.name}`,
      fileName: file.name,
      createdAt: 1,
    };
  }

  retainImage(attachmentId: string): () => void {
    this.retained.add(attachmentId);
    return () => this.retained.delete(attachmentId);
  }

  async uploadFiles(serverId: string, files: SharedFile[]): Promise<FileAttachment[]> {
    if (this.uploadError) throw this.uploadError;
    this.uploadedTo.push(serverId);
    return files.map((file) => ({
      kind: "file",
      attachment: {
        type: "uploaded_file",
        id: `upload:${file.name}`,
        fileName: file.name,
        mimeType: file.mimeType,
        size: 10,
        path: `/uploads/${file.name}`,
      },
    }));
  }

  async appendDraftInput(input: { draftKey: string; addition: DraftInput }): Promise<void> {
    this.drafts.push(input);
  }

  openAgent(input: { serverId: string; agentId: string }): void {
    this.opened.push({ kind: "agent", ...input });
  }

  openWorkspaceDraft(input: { serverId: string; workspaceId: string; draftId: string }): void {
    this.opened.push({ kind: "workspace", ...input });
  }
}

const deck: SharedFile = {
  uri: "file:///cache/deck.pptx",
  name: "deck.pptx",
  mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
const screenshot: SharedFile = {
  uri: "file:///cache/screen.png",
  name: "screen.png",
  mimeType: "image/png",
};
const notes: SharedFile = {
  uri: "file:///cache/notes.pdf",
  name: "notes.pdf",
  mimeType: "application/pdf",
};

function attachmentLabels(addition: DraftInput | undefined): string[] {
  return (addition?.attachments ?? []).map((attachment) => {
    if (attachment.kind === "image") return attachment.metadata.id;
    if (attachment.kind === "file") return attachment.attachment.id;
    return attachment.kind;
  });
}

describe("deliverShare", () => {
  it("adds the files to an agent's composer in the order they were shared, then opens it", async () => {
    const host = new FakeDeliveryHost();
    const share: IncomingShare = {
      id: "s1",
      text: "Review these",
      files: [deck, screenshot, notes],
    };

    await deliverShare(share, { kind: "agent", serverId: "host-1", agentId: "agent-1" }, host);

    expect(host.drafts).toHaveLength(1);
    expect(host.drafts[0]?.draftKey).toBe("agent:host-1:agent-1");
    expect(host.drafts[0]?.addition.text).toBe("Review these");
    expect(attachmentLabels(host.drafts[0]?.addition)).toEqual([
      "upload:deck.pptx",
      "image:screen.png",
      "upload:notes.pdf",
    ]);
    expect(host.uploadedTo).toEqual(["host-1"]);
    expect(host.opened).toEqual([{ kind: "agent", serverId: "host-1", agentId: "agent-1" }]);
    // Once the draft references the image, garbage collection keeps it without the hold.
    expect(host.retained.size).toBe(0);
  });

  it("starts a new agent draft in a workspace and opens that draft", async () => {
    const host = new FakeDeliveryHost();
    const share: IncomingShare = { id: "s1", text: "", files: [deck] };

    await deliverShare(share, { kind: "workspace", serverId: "host-2", workspaceId: "ws-9" }, host);

    const opened = host.opened[0] as { kind: string; workspaceId: string; draftId: string };
    expect(opened).toMatchObject({ kind: "workspace", serverId: "host-2", workspaceId: "ws-9" });
    expect(host.drafts[0]?.draftKey).toBe(`draft:host-2:${opened.draftId}`);
    expect(attachmentLabels(host.drafts[0]?.addition)).toEqual(["upload:deck.pptx"]);
  });

  it("skips the upload for a share of only images and text", async () => {
    const host = new FakeDeliveryHost();
    host.uploadError = new Error("host is offline");

    await deliverShare(
      { id: "s1", text: "", files: [screenshot] },
      { kind: "agent", serverId: "host-1", agentId: "agent-1" },
      host,
    );

    expect(attachmentLabels(host.drafts[0]?.addition)).toEqual(["image:screen.png"]);
  });

  it("leaves the draft untouched and stays put when the upload fails", async () => {
    const host = new FakeDeliveryHost();
    host.uploadError = new Error("deck.pptx is larger than 50MB");

    await expect(
      deliverShare(
        { id: "s1", text: "Review", files: [deck] },
        { kind: "agent", serverId: "host-1", agentId: "agent-1" },
        host,
      ),
    ).rejects.toThrow("deck.pptx is larger than 50MB");
    expect(host.drafts).toEqual([]);
    expect(host.opened).toEqual([]);
  });
});
