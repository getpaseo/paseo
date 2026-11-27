// @vitest-environment jsdom
import type { ReactNode } from "react";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { FileReadResult } from "@getpaseo/client/internal/daemon-client";
import { __setAttachmentStoreForTests } from "@/attachments/store";
import type { AttachmentStore } from "@/attachments/types";
import { useMarkdownSource, type MarkdownImageContext } from "./images";
import { PENDING_MARKDOWN_IMAGE } from "./source";

const memoryStore: AttachmentStore = {
  storageType: "web-indexeddb",
  async save(input) {
    return {
      id: input.id ?? "att_chart",
      mimeType: input.mimeType ?? "image/png",
      storageType: "web-indexeddb",
      storageKey: input.id ?? "att_chart",
      fileName: input.fileName,
      createdAt: 1,
    };
  },
  async encodeBase64() {
    return "";
  },
  async resolvePreviewUrl() {
    return "blob:chart";
  },
  async releasePreviewUrl() {},
  async delete() {},
  async garbageCollect() {},
};

function createHostFiles() {
  const reads: { cwd: string; path: string }[] = [];
  return {
    reads,
    async readFile(cwd: string, path: string): Promise<FileReadResult> {
      reads.push({ cwd, path });
      return {
        kind: "image",
        path,
        mime: "image/png",
        size: 4,
        modifiedAt: "2026-11-18T00:00:00.000Z",
        bytes: new Uint8Array([1, 2, 3, 4]),
      };
    },
  };
}

beforeEach(() => {
  __setAttachmentStoreForTests(memoryStore);
});

afterEach(() => {
  cleanup();
  __setAttachmentStoreForTests(null);
});

function renderMarkdownSource(text: string, initialProps: MarkdownImageContext) {
  // No retries: a failed read settles at once. For a host's Markdown this is the state once the
  // retries have run out on a host that is slow to connect.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const rendered = renderHook((props: MarkdownImageContext) => useMarkdownSource(text, props), {
    wrapper,
    initialProps,
  });
  return { ...rendered, queryClient };
}

it("waits for the host's client before reading a workspace image", async () => {
  const context = { serverId: "srv_test", workspaceRoot: "/repo" };
  const { result, rerender, queryClient } = renderMarkdownSource("![Chart](chart.png)", {
    ...context,
    client: null,
  });

  await waitFor(() => {
    expect(queryClient.isFetching()).toBe(0);
    expect(result.current.markdown.replace(PENDING_MARKDOWN_IMAGE, "pending")).toBe(
      "![Chart](<pending>)",
    );
  });

  const files = createHostFiles();
  rerender({ ...context, client: files });

  await waitFor(() => expect(result.current.imageSources).toEqual({ "blob:chart": "chart.png" }));
  expect(files.reads).toEqual([{ cwd: "/repo", path: "chart.png" }]);
});

it("shows the alt text of a file image in Markdown that belongs to no host", async () => {
  const { result } = renderMarkdownSource("![Chart](/tmp/chart.png)", {});

  await waitFor(() =>
    expect(result.current.markdown.replace(PENDING_MARKDOWN_IMAGE, "pending")).toBe("Chart"),
  );
});
