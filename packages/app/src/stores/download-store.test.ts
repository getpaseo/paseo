import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/constants/platform", () => ({
  isWeb: true,
}));

vi.mock("expo-file-system", () => ({
  File: vi.fn(),
  Paths: {},
}));

vi.mock("expo-file-system/legacy", () => ({
  createDownloadResumable: vi.fn(),
}));

vi.mock("expo-sharing", () => ({
  isAvailableAsync: vi.fn(async () => false),
  shareAsync: vi.fn(),
}));

vi.mock("@/utils/open-external-url", () => ({
  openExternalUrl: vi.fn(),
}));

describe("download store", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("falls back to WebSocket file bytes when web download host is unavailable", async () => {
    const createObjectURL = vi.fn(() => "blob:paseo-download");
    const revokeObjectURL = vi.fn();
    const click = vi.fn();
    const appendChild = vi.fn();
    const remove = vi.fn();

    vi.stubGlobal("URL", {
      createObjectURL,
      revokeObjectURL,
    });
    vi.stubGlobal(
      "Blob",
      class MockBlob {
        readonly parts: unknown[];
        readonly options: unknown;

        constructor(parts: unknown[], options: unknown) {
          this.parts = parts;
          this.options = options;
        }
      },
    );
    vi.stubGlobal("document", {
      createElement: vi.fn(() => ({
        click,
        remove,
        href: "",
        download: "",
        rel: "",
      })),
      body: { appendChild },
    });

    const { useDownloadStore } = await import("@/stores/download-store");
    const bytes = new TextEncoder().encode("docx bytes");

    await useDownloadStore.getState().startDownload({
      serverId: "srv",
      scopeId: "ws",
      fileName: "report.docx",
      path: "report.docx",
      daemonProfile: {
        serverId: "srv",
        label: "srv",
        lifecycle: {},
        connections: [],
        preferredConnectionId: null,
        createdAt: "2026-05-05T00:00:00.000Z",
        updatedAt: "2026-05-05T00:00:00.000Z",
      },
      requestFileDownloadToken: vi.fn(async () => {
        throw new Error("should not request token without a download host");
      }),
      requestFileBytes: vi.fn(async () => ({
        bytes,
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      })),
    });

    const download = Array.from(useDownloadStore.getState().downloads.values())[0];
    expect(download?.status).toBe("complete");
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(appendChild).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
