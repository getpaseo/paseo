import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { UserMessage } from "./message";
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
