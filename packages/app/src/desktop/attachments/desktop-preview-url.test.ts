import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invokeDesktopCommandMock } = vi.hoisted(() => ({
  invokeDesktopCommandMock: vi.fn(async () => "AAECAw=="),
}));

vi.mock("@/desktop/tauri/invoke-desktop-command", () => ({
  invokeDesktopCommand: invokeDesktopCommandMock,
}));

import {
  __desktopPreviewUrlTestUtils,
  releaseDesktopPreviewUrl,
  resolveDesktopPreviewUrl,
} from "./desktop-preview-url";

describe("desktop preview URLs", () => {
  const createObjectURL = vi.fn(() => "blob:desktop-preview-1");
  const revokeObjectURL = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("URL", {
      createObjectURL,
      revokeObjectURL,
    });
  });

  afterEach(() => {
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
    invokeDesktopCommandMock.mockClear();
    __desktopPreviewUrlTestUtils.clearActiveObjectUrls();
    vi.unstubAllGlobals();
  });

  it("resolves renderer-safe blob URLs for desktop attachments", async () => {
    const url = await resolveDesktopPreviewUrl({
      id: "att-1",
      mimeType: "image/png",
      storageType: "desktop-file",
      storageKey: "/tmp/att-1.png",
      createdAt: Date.now(),
    });

    expect(invokeDesktopCommandMock).toHaveBeenCalledWith("read_file_base64", {
      path: "/tmp/att-1.png",
    });
    expect(url).toBe("blob:desktop-preview-1");
    expect(url.startsWith("asset://")).toBe(false);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("releases blob URLs via URL.revokeObjectURL", async () => {
    const url = await resolveDesktopPreviewUrl({
      id: "att-2",
      mimeType: "image/jpeg",
      storageType: "desktop-file",
      storageKey: "/tmp/att-2.jpg",
      createdAt: Date.now(),
    });

    await releaseDesktopPreviewUrl({ url });

    expect(revokeObjectURL).toHaveBeenCalledWith("blob:desktop-preview-1");
  });
});
