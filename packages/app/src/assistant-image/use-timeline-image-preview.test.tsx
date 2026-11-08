/**
 * @vitest-environment jsdom
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import React, { type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttachmentMetadata } from "@/attachments/types";
import { useTimelineImagePreview } from "./use-timeline-image-preview";

const releaseRetained = vi.fn();
const retainAttachmentForGarbageCollection = vi.fn((_id: string) => releaseRetained);
const persistAttachmentFromBytes = vi.fn();
const resolveAttachmentPreviewUrl = vi.fn();
const releaseAttachmentPreviewUrl = vi.fn();

vi.mock("@/attachments/service", () => ({
  persistAttachmentFromBytes: (input: unknown) => persistAttachmentFromBytes(input),
  resolveAttachmentPreviewUrl: (metadata: unknown) => resolveAttachmentPreviewUrl(metadata),
  releaseAttachmentPreviewUrl: (input: unknown) => releaseAttachmentPreviewUrl(input),
}));

vi.mock("@/attachments/gc-retention", () => ({
  retainAttachmentForGarbageCollection: (id: string) => retainAttachmentForGarbageCollection(id),
}));

function attachment(id: string): AttachmentMetadata {
  return {
    id,
    mimeType: "image/png",
    storageType: "web-indexeddb",
    storageKey: id,
    fileName: `${id}.png`,
    byteSize: 4,
    createdAt: 1,
  };
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Infinity } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return React.createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useTimelineImagePreview", () => {
  it("renders a remote image url directly without reading it from the host", async () => {
    const client = { readFile: vi.fn() };

    const { result } = renderHook(
      () =>
        useTimelineImagePreview({
          source: "https://files.example.com/instructions.png",
          occurrenceKey: "agent-1:message-1:image-0",
          client,
          workspaceRoot: "/workspace",
          serverId: "server",
        }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.status).toBe("loaded"));
    expect(result.current.uri).toBe("https://files.example.com/instructions.png");
    expect(client.readFile).not.toHaveBeenCalled();
    expect(persistAttachmentFromBytes).not.toHaveBeenCalled();
  });

  it("reads a workspace-relative host path and retains the fetched attachment", async () => {
    const persisted = attachment("att-file");
    persistAttachmentFromBytes.mockResolvedValue(persisted);
    resolveAttachmentPreviewUrl.mockResolvedValue("blob:preview-file");
    const client = {
      readFile: vi.fn(async () => ({
        kind: "image" as const,
        path: "uploads/chart.png",
        mime: "image/png",
        size: 4,
        modifiedAt: "1",
        bytes: new Uint8Array([1, 2, 3, 4]),
      })),
    };

    const { result, unmount } = renderHook(
      () =>
        useTimelineImagePreview({
          source: "uploads/chart.png",
          occurrenceKey: "agent-1:message-1:chart",
          client,
          workspaceRoot: "/workspace",
          serverId: "server",
        }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.status).toBe("loaded"));
    expect(result.current.uri).toBe("blob:preview-file");
    expect(client.readFile).toHaveBeenCalledWith("/workspace", "uploads/chart.png");
    expect(retainAttachmentForGarbageCollection).toHaveBeenCalledWith(persisted.id);

    // The preview outlives the component: unmounting drops this consumer but keeps the
    // cached attachment so a remount does not read the file again.
    unmount();
    expect(releaseRetained).not.toHaveBeenCalled();

    const remounted = renderHook(
      () =>
        useTimelineImagePreview({
          source: "uploads/chart.png",
          occurrenceKey: "agent-1:message-1:chart",
          client,
          workspaceRoot: "/workspace",
          serverId: "server",
        }),
      { wrapper: createWrapper() },
    );
    await waitFor(() => expect(remounted.result.current.status).toBe("loaded"));
    expect(client.readFile).toHaveBeenCalledTimes(1);
    remounted.unmount();
  });

  it("reports failure when there is no host client to read the file", async () => {
    const { result } = renderHook(
      () =>
        useTimelineImagePreview({
          source: "uploads/chart.png",
          occurrenceKey: "agent-1:message-1:no-client",
          client: null,
          workspaceRoot: "/workspace",
          serverId: "server",
        }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.status).toBe("failed"));
    expect(persistAttachmentFromBytes).not.toHaveBeenCalled();
  });
});
