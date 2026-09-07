import React, { act, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import Markdown, { type ASTNode } from "react-native-markdown-display";
import type { FileReadResult } from "@getpaseo/client/internal/daemon-client";
import { i18n } from "@/i18n/i18next";
import { createAssistantMarkdownParser } from "@/utils/assistant-markdown-parser";
import { AssistantVideo, type AssistantVideoProps } from "./index";
import { assistantVideoMarkdown } from "./markdown";
import { VIDEO_PREVIEW_MAX_BYTES } from "@/attachments/preview-limits";

vi.stubGlobal("React", React);

const fixture = new URL("../components/video-preview/fixtures/colors.webm", import.meta.url).href;
let root: Root | null = null;
let container: HTMLDivElement;
let queryClient: QueryClient;

function ChatVideo({ props }: { props: AssistantVideoProps }) {
  const parser = useMemo(() => createAssistantMarkdownParser().use(assistantVideoMarkdown), []);
  const rules = useMemo(
    () => ({
      video: (node: ASTNode) => (
        <AssistantVideo key={node.key} {...props} source={String(node.attributes.src)} />
      ),
    }),
    [props],
  );
  return <Markdown markdownit={parser} rules={rules}>{`[Recording](${props.source})`}</Markdown>;
}

function renderVideo(props: AssistantVideoProps) {
  container = document.createElement("div");
  container.style.width = "640px";
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient();
  act(() => {
    root?.render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={queryClient}>
          <ChatVideo props={props} />
        </QueryClientProvider>
      </I18nextProvider>,
    );
  });
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
  queryClient.clear();
});

describe("agent video in chat", () => {
  it("renders and plays a linked video while keeping its original link", async () => {
    renderVideo({ source: fixture });
    await expect.poll(() => container.querySelector("video")?.videoWidth).toBe(64);
    expect(container.textContent).toContain("Recording");
    const video = container.querySelector("video");
    if (!video) throw new Error("Expected a chat video");
    expect(video.controls).toBe(true);
    expect(video.getBoundingClientRect().width).toBe(64);
    video.muted = true;
    await video.play();
    await expect.poll(() => video.currentTime).toBeGreaterThan(0);
  });

  it("reads local video bytes through the daemon port and plays the cached attachment", async () => {
    const response = await fetch(fixture);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const reads: unknown[][] = [];
    const client: NonNullable<AssistantVideoProps["client"]> = {
      async readFile(...args): Promise<FileReadResult> {
        reads.push(args);
        return {
          bytes,
          size: bytes.length,
          path: "recording.webm",
          kind: "binary",
          mime: "application/octet-stream",
          modifiedAt: "2026-09-07T00:00:00Z",
        };
      },
    };
    renderVideo({
      source: "recording.webm",
      workspaceRoot: "/workspace",
      serverId: "test-video-host",
      client,
    });
    await expect.poll(() => container.querySelector("video")?.videoWidth).toBe(64);
    expect(reads).toEqual([["/workspace", "recording.webm", undefined, VIDEO_PREVIEW_MAX_BYTES]]);
    expect(container.querySelector("video")?.src.startsWith("blob:")).toBe(true);
  });

  it("shows a failed file read and retries it in place", async () => {
    const response = await fetch(fixture);
    const bytes = new Uint8Array(await response.arrayBuffer());
    let attempts = 0;
    const client: NonNullable<AssistantVideoProps["client"]> = {
      async readFile(): Promise<FileReadResult> {
        attempts += 1;
        if (attempts === 1) throw new Error("Video file is unavailable");
        return {
          bytes,
          size: bytes.length,
          path: "retry.webm",
          kind: "binary",
          mime: "application/octet-stream",
          modifiedAt: "2026-09-07T00:00:00Z",
        };
      },
    };
    renderVideo({
      source: "retry.webm",
      workspaceRoot: "/workspace",
      serverId: "test-video-host",
      client,
    });
    await expect.poll(() => container.textContent).toContain("Video file is unavailable");
    const retry = container.querySelector('[role="button"]');
    if (!(retry instanceof HTMLElement)) throw new Error("Expected retry");
    act(() => retry.click());
    await expect.poll(() => container.querySelector("video")?.videoWidth).toBe(64);
    expect(attempts).toBe(2);
    expect(container.querySelector('[data-testid="assistant-video-error"]')).toBeNull();
  });
});
