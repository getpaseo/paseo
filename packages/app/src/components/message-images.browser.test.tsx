import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { UserMessage } from "./message";
import { getAttachmentStore } from "@/attachments/store";
import { garbageCollectAttachments } from "@/attachments/service";
import type { AttachmentMetadata } from "@/attachments/types";
import { useRewindAgentMutation } from "./rewind/use-rewind-agent-mutation";

// Keep message actions observable without requiring a workspace composer or toast host.
vi.mock("./rewind/use-rewind-agent-mutation", () => ({
  useRewindAgentMutation: vi.fn(() => ({ rewindAgent: vi.fn(), isPending: false })),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const imageId = "child-image";
const png = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
  ),
  (character) => character.charCodeAt(0),
);
let root: Root;
let host: HTMLDivElement;
let queryClient: QueryClient;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  act(() => root.unmount());
  queryClient.clear();
  host.remove();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

for (const imageAgentId of ["parent-agent", undefined]) {
  it(`reads images with ${imageAgentId ? "the explicit parent owner" : "the default agent id"} without changing message identity`, async () => {
    const agentId = "provider:parent-agent:child-agent";
    const client = new DaemonClient({ url: "ws://unused", clientId: "image-display-test" });
    const readImage = vi.spyOn(client, "readTimelineImage").mockResolvedValue({
      bytes: png,
      mime: "image/png",
      size: png.byteLength,
      path: "child.png",
      kind: "image",
      modifiedAt: "2026-01-01T00:00:00.000Z",
    });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <UserMessage
            agentId={agentId}
            imageAgentId={imageAgentId}
            serverId="image-display-server"
            client={client}
            messageId="child-message"
            message="Child image"
            imageRefs={[
              { kind: "stored", id: imageId, mimeType: "image/png", byteSize: png.byteLength },
            ]}
            timestamp={0}
          />
        </QueryClientProvider>,
      );
    });
    await expect.poll(() => readImage.mock.calls).toEqual([[imageAgentId ?? agentId, imageId]]);
    expect(vi.mocked(useRewindAgentMutation).mock.lastCall?.[0]).toEqual({
      serverId: "image-display-server",
      agentId,
      client,
      messageId: "child-message",
    });
    await expect.poll(() => host.querySelector("img")?.naturalWidth).toBe(1);
    expect(host.querySelector('[data-testid="user-message"]')?.textContent).toContain(
      "Child image",
    );
  });
}

for (const localCopy of ["preserved", "deleted", "garbage-collected", "in-flight-gc"] as const) {
  it(`reuses a ${localCopy} local image only when its bytes still exist after a virtualized remount`, async () => {
    const id = `remount-${localCopy}`;
    const client = new DaemonClient({ url: "ws://unused", clientId: "image-remount-test" });
    const readImage = vi.spyOn(client, "readTimelineImage").mockResolvedValue({
      bytes: png,
      mime: "image/png",
      size: png.byteLength,
      path: "remount.png",
      kind: "image",
      modifiedAt: "2026-01-01T00:00:00.000Z",
    });
    const renderRow = async (visible: boolean) => {
      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            {visible ? (
              <UserMessage
                agentId="remount-agent"
                serverId="remount-server"
                client={client}
                messageId="remount-message"
                message="Remounted image"
                imageRefs={[
                  { kind: "stored", id, mimeType: "image/png", byteSize: png.byteLength },
                ]}
                timestamp={0}
              />
            ) : null}
          </QueryClientProvider>,
        );
      });
    };
    const acquisitionKey = ["timelineImage", "remount-server", "remount-agent", id];
    await renderRow(true);
    await expect.poll(() => host.querySelector("img")?.naturalWidth).toBe(1);
    expect(readImage).toHaveBeenCalledTimes(1);
    const attachment = queryClient.getQueryData<AttachmentMetadata>(acquisitionKey);
    expect(attachment).toBeDefined();
    if (!attachment) throw new Error("Image attachment was not acquired");
    const store = await getAttachmentStore();
    // Mounted thumbnails remain protected from the app's attachment GC.
    await garbageCollectAttachments({ referencedIds: new Set() });
    expect(await store.encodeBase64({ attachment })).toBe(btoa(String.fromCharCode(...png)));
    await renderRow(false);
    await expect
      .poll(() => queryClient.getQueryCache().find({ queryKey: acquisitionKey }))
      .toBeUndefined();
    if (localCopy === "deleted") await store.delete({ attachment });
    if (localCopy === "garbage-collected") {
      await garbageCollectAttachments({ referencedIds: new Set() });
    }
    if (localCopy === "in-flight-gc") {
      // Pause a real GC after it has snapshotted the unmounted row's references.
      let resumeGc = () => {};
      const gcGate = new Promise<void>((resolve) => {
        resumeGc = resolve;
      });
      let enteredGc = () => {};
      const gcStarted = new Promise<void>((resolve) => {
        enteredGc = resolve;
      });
      const collect = store.garbageCollect.bind(store);
      vi.spyOn(store, "garbageCollect").mockImplementation(async (input) => {
        expect(input.referencedIds.has(attachment.id)).toBe(false);
        enteredGc();
        await gcGate;
        await collect(input);
        await expect(store.encodeBase64({ attachment })).rejects.toThrow("was not found");
      });
      const collecting = garbageCollectAttachments({ referencedIds: new Set() });
      await gcStarted;
      let finishedRead = false;
      const encode = store.encodeBase64.bind(store);
      vi.spyOn(store, "encodeBase64").mockImplementation(async (input) => {
        const base64 = await encode(input);
        finishedRead = true;
        return base64;
      });
      try {
        await renderRow(true);
        await expect.poll(() => finishedRead).toBe(true);
      } finally {
        resumeGc();
        await collecting;
      }
    } else {
      await renderRow(true);
    }
    await expect.poll(() => host.querySelector("img")?.naturalWidth).toBe(1);
    expect(readImage).toHaveBeenCalledTimes(
      localCopy === "deleted" || localCopy === "garbage-collected" ? 2 : 1,
    );
    expect(await store.encodeBase64({ attachment })).toBe(btoa(String.fromCharCode(...png)));
  });
}
