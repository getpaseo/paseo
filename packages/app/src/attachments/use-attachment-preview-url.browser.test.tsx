import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { persistAttachmentFromBlob } from "@/attachments/service";
import type { AttachmentMetadata } from "@/attachments/types";
import { type AttachmentPreviewUrl, useAttachmentPreviewUrl } from "./use-attachment-preview-url";

let root: Root;
let container: HTMLDivElement;
let latest: AttachmentPreviewUrl | null = null;

function PreviewProbe({ attachment }: { attachment: AttachmentMetadata | null }) {
  latest = useAttachmentPreviewUrl(attachment);
  return null;
}

async function render(attachment: AttachmentMetadata | null) {
  await act(async () => root.render(<PreviewProbe attachment={attachment} />));
}

async function waitForReady(): Promise<string> {
  await vi.waitFor(() => expect(latest?.status).toBe("ready"));
  if (latest?.status !== "ready") throw new Error("preview never resolved");
  return latest.url;
}

beforeEach(() => {
  vi.stubGlobal("React", React);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  latest = null;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("never hands back a URL it already released when the same attachment returns", async () => {
  const attachment = await persistAttachmentFromBlob({
    blob: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
    mimeType: "image/png",
    fileName: "shot.png",
  });

  await render(attachment);
  const released = await waitForReady();
  await render(null);
  await render(attachment);

  expect(latest).not.toEqual({ status: "ready", url: released });
  expect(await waitForReady()).not.toBe(released);
});
