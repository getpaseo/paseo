// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AttachmentStore } from "@/attachments/types";
import { __setAttachmentStoreForTests } from "@/attachments/store";
import {
  isAssistantVideoSource,
  useAssistantVideo,
  MAX_INLINE_VIDEO_BYTES,
} from "./use-assistant-video";

function createRecordingStore(): AttachmentStore {
  return {
    storageType: "web-indexeddb",
    async save(input) {
      return {
        id: input.id ?? "att_video",
        mimeType: input.mimeType ?? "application/octet-stream",
        storageType: "web-indexeddb",
        storageKey: input.id ?? "att_video",
        fileName: input.fileName,
        byteSize: 4,
        createdAt: 1700000000000,
      };
    },
    async encodeBase64({ attachment }) {
      return `${attachment.id}:base64`;
    },
    async resolvePreviewUrl({ attachment }) {
      return `blob:${attachment.id}`;
    },
    async releasePreviewUrl() {},
    async delete() {},
    async garbageCollect() {},
  };
}

interface FakeClient {
  reads: Array<{ cwd: string; path: string; maxBytes?: number }>;
  client: DaemonClient;
}

function createFakeClient(file: { mime: string; kind: "image" | "binary" }): FakeClient {
  const reads: FakeClient["reads"] = [];
  const client = {
    async readFile(cwd: string, path: string, _requestId?: string, maxBytes?: number) {
      reads.push({ cwd, path, maxBytes });
      return {
        bytes: new Uint8Array([1, 2, 3, 4]),
        mime: file.mime,
        size: 4,
        path,
        kind: file.kind,
        modifiedAt: "2026-01-01T00:00:00.000Z",
      };
    },
  } as unknown as DaemonClient;
  return { reads, client };
}

let occurrence = 0;
function nextOccurrenceKey(): string {
  occurrence += 1;
  return `agent:message:video-${occurrence}`;
}

describe("isAssistantVideoSource", () => {
  it("routes only browser-playable video extensions to the player", () => {
    expect(isAssistantVideoSource("recordings/demo.mp4")).toBe(true);
    expect(isAssistantVideoSource("file:///tmp/demo.webm")).toBe(true);
    expect(isAssistantVideoSource("https://example.com/clip.mov?token=1")).toBe(true);
    expect(isAssistantVideoSource("screenshot.png")).toBe(false);
    expect(isAssistantVideoSource("archive.mkv")).toBe(false);
    expect(isAssistantVideoSource("   ")).toBe(false);
  });
});

describe("useAssistantVideo", () => {
  afterEach(() => {
    __setAttachmentStoreForTests(null);
  });

  it("reads a workspace video under the byte ceiling and reports its aspect ratio", async () => {
    __setAttachmentStoreForTests(createRecordingStore());
    const { reads, client } = createFakeClient({ mime: "video/mp4", kind: "binary" });

    const occurrenceKey = nextOccurrenceKey();
    const { result } = renderHook(() =>
      useAssistantVideo({
        source: "recordings/demo.mp4",
        occurrenceKey,
        client,
        workspaceRoot: "/workspace",
        serverId: "server",
      }),
    );

    await waitFor(() => {
      expect(result.current.status === "failed" ? null : result.current.binding).not.toBeNull();
    });

    expect(reads).toEqual([
      { cwd: "/workspace", path: "recordings/demo.mp4", maxBytes: MAX_INLINE_VIDEO_BYTES },
    ]);

    const binding = result.current.status === "failed" ? null : result.current.binding;
    expect(binding?.uri).toMatch(/^blob:/);
    expect(binding?.mimeType).toBe("video/mp4");

    act(() => {
      binding?.onLoadedMetadata({ width: 1920, height: 1080 });
    });

    expect(result.current.status).toBe("loaded");
    expect(result.current.status === "loaded" ? result.current.aspectRatio : null).toBeCloseTo(
      16 / 9,
    );
  });

  it("fails instead of collapsing when metadata reports no picture", async () => {
    __setAttachmentStoreForTests(createRecordingStore());
    const { client } = createFakeClient({ mime: "video/webm", kind: "binary" });

    const occurrenceKey = nextOccurrenceKey();
    const { result } = renderHook(() =>
      useAssistantVideo({
        source: "recordings/audio-only.webm",
        occurrenceKey,
        client,
        workspaceRoot: "/workspace",
        serverId: "server",
      }),
    );

    await waitFor(() => {
      expect(result.current.status === "failed" ? null : result.current.binding).not.toBeNull();
    });
    const binding = result.current.status === "failed" ? null : result.current.binding;

    act(() => {
      binding?.onLoadedMetadata({ width: 0, height: 0 });
    });

    expect(result.current.status).toBe("failed");
  });

  it("falls back when the daemon does not report a video MIME type", async () => {
    __setAttachmentStoreForTests(createRecordingStore());
    const { client } = createFakeClient({ mime: "application/octet-stream", kind: "binary" });

    const occurrenceKey = nextOccurrenceKey();
    const { result } = renderHook(() =>
      useAssistantVideo({
        source: "recordings/demo.mp4",
        occurrenceKey,
        client,
        workspaceRoot: "/workspace",
        serverId: "server",
      }),
    );

    // The acquisition retries a failed read three times before giving up
    // (ASSISTANT_IMAGE_RETRY_DELAYS_MS), so the fallback lands ~1.7s in.
    await waitFor(
      () => {
        expect(result.current.status).toBe("failed");
      },
      { timeout: 5_000 },
    );
    // The card has to name the file: a turn can carry several videos, and a
    // refusal that only states the reason leaves the reader guessing which one.
    expect(result.current.status === "failed" ? result.current.path : null).toBe(
      "recordings/demo.mp4",
    );
  });

  it("plays a remote URL without reading it through the daemon", async () => {
    __setAttachmentStoreForTests(createRecordingStore());
    const { reads, client } = createFakeClient({ mime: "video/mp4", kind: "binary" });

    const occurrenceKey = nextOccurrenceKey();
    const { result } = renderHook(() =>
      useAssistantVideo({
        source: "https://example.com/clip.mp4",
        occurrenceKey,
        client,
        workspaceRoot: "/workspace",
        serverId: "server",
      }),
    );

    await waitFor(() => {
      expect(result.current.status === "failed" ? null : result.current.binding).not.toBeNull();
    });
    const binding = result.current.status === "failed" ? null : result.current.binding;
    expect(binding?.uri).toBe("https://example.com/clip.mp4");
    expect(reads).toEqual([]);
  });
});
