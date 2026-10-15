import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  persist: vi.fn(),
  delete: vi.fn(),
  stage: vi.fn(),
}));

vi.mock("expo-file-system/legacy", () => ({
  cacheDirectory: "file:///cache/",
  deleteAsync: mocks.delete,
}));
vi.mock("@/attachments/service", () => ({ persistAttachmentFromFileUri: mocks.persist }));
vi.mock("./pending-prompt-store", () => ({ stagePendingPrompt: mocks.stage }));
vi.mock("@/utils/host-routes", () => ({ buildNewWorkspaceRoute: () => "/new" }));

import { stageSharedIntent } from "./stage-shared-intent";

const stagedUri = "file:///cache/shared-intents/12345678-1234-1234-1234-123456789abc/photo.jpg";
const payload = {
  kind: "share" as const,
  text: "Look at this",
  files: [{ uri: stagedUri, mimeType: "image/jpeg", fileName: "photo.jpg" }],
  skippedFiles: 0,
};

describe("stageSharedIntent", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.persist.mockResolvedValue({ id: "attachment-1" });
    mocks.delete.mockResolvedValue(undefined);
  });

  it("removes the native staging copy after persisting the attachment", async () => {
    await stageSharedIntent(payload);
    expect(mocks.delete).toHaveBeenCalledWith(
      "file:///cache/shared-intents/12345678-1234-1234-1234-123456789abc/",
      { idempotent: true },
    );
    expect(mocks.stage).toHaveBeenCalledOnce();
  });

  it("removes the staging copy when persistence fails", async () => {
    mocks.persist.mockRejectedValue(new Error("copy failed"));
    const result = await stageSharedIntent(payload);
    expect(result?.skippedFiles).toBe(1);
    expect(mocks.delete).toHaveBeenCalledOnce();
  });
});
