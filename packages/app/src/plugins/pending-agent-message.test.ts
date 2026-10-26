import { beforeEach, describe, expect, it, vi } from "vitest";
import { persistAttachmentFromDataUrl } from "@/attachments/service";
import type { AttachmentMetadata } from "@/attachments/types";
import { showDaemonSentAgentMessage, updateShownAgentMessage } from "@/composer/submission/writer";
import { showPluginPendingAgentMessage } from "./pending-agent-message";

vi.mock("@/attachments/service", () => ({
  persistAttachmentFromDataUrl: vi.fn(),
}));
vi.mock("@/composer/submission/writer", () => ({
  showDaemonSentAgentMessage: vi.fn(),
  updateShownAgentMessage: vi.fn(),
}));

const persistMock = vi.mocked(persistAttachmentFromDataUrl);
const showMock = vi.mocked(showDaemonSentAgentMessage);
const updateMock = vi.mocked(updateShownAgentMessage);

function stored(id: string): AttachmentMetadata {
  return { id, mimeType: "image/png", storageType: "web-indexeddb", storageKey: id, createdAt: 1 };
}

const file = {
  type: "uploaded_file" as const,
  id: "file-1",
  fileName: "spec.pdf",
  mimeType: "application/pdf",
  size: 3,
  path: "/host/files/spec.pdf",
};

describe("showPluginPendingAgentMessage", () => {
  beforeEach(() => {
    persistMock.mockReset();
    showMock.mockReset();
    updateMock.mockReset();
  });

  it("shows text and files at once, then adds the images once they are stored", async () => {
    let finishStoring!: (metadata: AttachmentMetadata) => void;
    persistMock.mockReturnValueOnce(
      new Promise((resolve) => {
        finishStoring = resolve;
      }),
    );

    const showing = showPluginPendingAgentMessage({
      serverId: "host-1",
      agentId: "agent-1",
      message: {
        clientMessageId: "message-1",
        text: "Do the work",
        images: [{ data: "aGk=", mimeType: "image/png" }],
        attachments: [file],
      },
    });

    // Storing is still pending, and the message is already shown.
    expect(showMock).toHaveBeenCalledWith(
      "host-1",
      "agent-1",
      expect.objectContaining({
        kind: "user_message",
        clientMessageId: "message-1",
        text: "Do the work",
        attachments: [file],
      }),
    );
    expect(showMock.mock.calls[0]?.[2]).not.toHaveProperty("images");
    expect(persistMock).toHaveBeenCalledWith({
      dataUrl: "data:image/png;base64,aGk=",
      mimeType: "image/png",
    });

    finishStoring(stored("image-1"));
    await showing;

    expect(updateMock).toHaveBeenCalledWith(
      "host-1",
      "agent-1",
      expect.objectContaining({
        clientMessageId: "message-1",
        text: "Do the work",
        images: [stored("image-1")],
        attachments: [file],
      }),
    );
  });

  it("leaves out an image it cannot store, and redraws nothing when none are stored", async () => {
    persistMock
      .mockRejectedValueOnce(new Error("quota exceeded"))
      .mockResolvedValueOnce(stored("image-2"));
    await showPluginPendingAgentMessage({
      serverId: "host-1",
      agentId: "agent-1",
      message: {
        clientMessageId: "message-1",
        text: "Do the work",
        images: [
          { data: "YQ==", mimeType: "image/png" },
          { data: "Yg==", mimeType: "image/png" },
        ],
      },
    });
    expect(updateMock.mock.calls[0]?.[2].images).toEqual([stored("image-2")]);

    updateMock.mockReset();
    persistMock.mockRejectedValueOnce(new Error("quota exceeded"));
    await showPluginPendingAgentMessage({
      serverId: "host-1",
      agentId: "agent-1",
      message: {
        clientMessageId: "message-2",
        text: "Do more",
        images: [{ data: "YQ==", mimeType: "image/png" }],
      },
    });
    expect(showMock).toHaveBeenLastCalledWith(
      "host-1",
      "agent-1",
      expect.objectContaining({ clientMessageId: "message-2", text: "Do more" }),
    );
    expect(updateMock).not.toHaveBeenCalled();
  });
});
