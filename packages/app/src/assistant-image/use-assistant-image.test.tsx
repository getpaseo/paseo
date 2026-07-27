/**
 * @vitest-environment jsdom
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ImageLoadEvent } from "react-native";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AttachmentStore } from "@/attachments/types";
import { __setAttachmentStoreForTests } from "@/attachments/store";
import { setAssistantImageMetadata } from "@/utils/assistant-image-metadata";
import { useAssistantImage } from "./use-assistant-image";

describe("useAssistantImage", () => {
  afterEach(() => {
    cleanup();
    __setAttachmentStoreForTests(null);
  });

  it("keeps a successfully loaded image when cached dimensions are available", async () => {
    const source = "https://example.com/expiring-image.png";
    setAssistantImageMetadata({ source }, { width: 640, height: 320 });
    const { result } = renderHook(() =>
      useAssistantImage({ source, occurrenceKey: "agent:message:image" }),
    );

    await waitFor(() => expect(result.current.status).toBe("loading"));
    const binding = result.current.status === "failed" ? null : result.current.binding;
    if (!binding) {
      throw new Error("Expected a direct image render binding");
    }
    act(() => {
      binding.onLoad({
        nativeEvent: { source: { uri: source, width: 0, height: 0 } },
      } as ImageLoadEvent);
    });

    expect(result.current).toMatchObject({ status: "loaded", aspectRatio: 2 });
  });

  it("uses browser image dimensions from the successful load event", async () => {
    const source = "https://example.com/browser-image.png";
    const { result } = renderHook(() =>
      useAssistantImage({ source, occurrenceKey: "agent:message:browser-image" }),
    );

    await waitFor(() => expect(result.current.status).toBe("loading"));
    const binding = result.current.status === "failed" ? null : result.current.binding;
    if (!binding) {
      throw new Error("Expected a direct image render binding");
    }
    act(() => {
      binding.onLoad({
        nativeEvent: { target: { naturalWidth: 800, naturalHeight: 400 } },
      } as unknown as ImageLoadEvent);
    });

    expect(result.current).toMatchObject({ status: "loaded", aspectRatio: 2 });
  });

  it("uses the rendered browser image when React Native Web clears the load target", async () => {
    const source = "https://example.com/react-native-web-image.png";
    const { result } = renderHook(() =>
      useAssistantImage({ source, occurrenceKey: "agent:message:react-native-web-image" }),
    );

    await waitFor(() => expect(result.current.status).toBe("loading"));
    const binding = result.current.status === "failed" ? null : result.current.binding;
    if (!binding) {
      throw new Error("Expected a direct image render binding");
    }
    const root = document.createElement("div");
    const image = document.createElement("img");
    Object.defineProperties(image, {
      naturalWidth: { value: 900 },
      naturalHeight: { value: 600 },
    });
    root.append(image);
    binding.onRef(root);
    act(() => {
      binding.onLoad({ nativeEvent: { target: null } } as unknown as ImageLoadEvent);
    });

    expect(result.current).toMatchObject({ status: "loaded", aspectRatio: 1.5 });
  });

  it("restores a previously loaded URI without returning to loading", async () => {
    const source = "https://example.com/remounted-image.png";
    const first = renderHook(() =>
      useAssistantImage({ source, occurrenceKey: "agent:message:remounted-image" }),
    );
    await waitFor(() => expect(first.result.current.status).toBe("loading"));
    const binding = first.result.current.status === "failed" ? null : first.result.current.binding;
    if (!binding) {
      throw new Error("Expected a direct image render binding");
    }
    act(() => {
      binding.onLoad({
        nativeEvent: { target: { naturalWidth: 800, naturalHeight: 400 } },
      } as unknown as ImageLoadEvent);
    });
    expect(first.result.current.status).toBe("loaded");
    first.unmount();

    const remounted = renderHook(() =>
      useAssistantImage({ source, occurrenceKey: "agent:message:remounted-image" }),
    );

    expect(remounted.result.current).toMatchObject({ status: "loaded", aspectRatio: 2 });
  });

  it("restarts a failed file acquisition when the daemon client reconnects", async () => {
    const attachmentStore: AttachmentStore = {
      storageType: "web-indexeddb",
      async save(input) {
        return {
          id: input.id ?? "assistant-image",
          mimeType: input.mimeType ?? "image/png",
          storageType: "web-indexeddb",
          storageKey: input.id ?? "assistant-image",
          fileName: input.fileName,
          byteSize: 4,
          createdAt: 1,
        };
      },
      async encodeBase64() {
        return "";
      },
      async resolvePreviewUrl({ attachment }) {
        return `blob:${attachment.id}`;
      },
      async delete() {},
      async garbageCollect() {},
    };
    __setAttachmentStoreForTests(attachmentStore);

    let readCount = 0;
    const connectedClient = {
      async readFile(_cwd: string, path: string) {
        readCount += 1;
        return {
          kind: "image" as const,
          path,
          mime: "image/png",
          size: 4,
          modifiedAt: "1",
          bytes: new Uint8Array([1, 2, 3, 4]),
        };
      },
    } as unknown as DaemonClient;
    const initialProps: { client: DaemonClient | null } = { client: null };
    const { result, rerender } = renderHook(
      ({ client }: { client: DaemonClient | null }) =>
        useAssistantImage({
          source: "/workspace/reconnect.png",
          occurrenceKey: "agent:message:reconnect-image",
          client,
          workspaceRoot: "/workspace",
          serverId: "server",
        }),
      { initialProps },
    );

    await waitFor(() => expect(result.current.status).toBe("failed"), { timeout: 3_000 });

    rerender({ client: connectedClient });

    await waitFor(() => {
      expect(readCount).toBe(1);
      expect(result.current.status).toBe("loading");
      expect(result.current.status === "loading" && result.current.binding).not.toBeNull();
    });
  });
});
