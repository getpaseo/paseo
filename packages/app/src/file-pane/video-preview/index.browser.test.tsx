import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nextProvider } from "react-i18next";
import { i18n } from "@/i18n/i18next";
import { RetainedPanel } from "@/components/retained-panel";
import { FileVideoPreview } from "./index";

const videoUri = new URL("./fixtures/colors.webm", import.meta.url).href;
const panelStyle = { width: 640, height: 360 };
let root: Root | null = null;
let container: HTMLDivElement;
const objectUrls: string[] = [];

function renderPreview(uri: string | null, active = true) {
  if (!root) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() => {
    root?.render(
      <I18nextProvider i18n={i18n}>
        <RetainedPanel active={active} style={panelStyle} testID="video-test-pane">
          <FileVideoPreview key={uri} uri={uri} />
        </RetainedPanel>
      </I18nextProvider>,
    );
  });
}

function videoElement(): HTMLVideoElement {
  const video = container.querySelector("video");
  if (!video) throw new Error("Expected a video player");
  return video;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
  for (const url of objectUrls.splice(0)) URL.revokeObjectURL(url);
});

describe("video file preview", () => {
  it("caps the preview at its intrinsic size and shrinks it to fit a smaller pane", async () => {
    renderPreview(videoUri);
    const video = videoElement();
    await expect.poll(() => video.videoWidth).toBe(64);
    await expect.poll(() => video.getBoundingClientRect().width).toBe(64);
    expect(video.getBoundingClientRect().height).toBe(64);

    const pane = container.querySelector('[data-testid="video-test-pane"]');
    if (!(pane instanceof HTMLElement)) throw new Error("Expected the video pane");
    pane.style.width = "32px";
    pane.style.height = "16px";
    await expect.poll(() => video.getBoundingClientRect().width).toBe(16);
    expect(video.getBoundingClientRect().height).toBe(16);

    pane.style.width = "640px";
    pane.style.height = "360px";
    await expect.poll(() => video.getBoundingClientRect().width).toBe(64);
    expect(video.getBoundingClientRect().height).toBe(64);
  });

  it("plays and seeks with browser controls, then pauses when its retained pane is hidden", async () => {
    renderPreview(videoUri);
    const video = videoElement();
    await expect.poll(() => video.videoWidth).toBe(64);
    expect(video.videoHeight).toBe(64);
    await expect
      .poll(() => container.querySelector('[data-testid="video-file-preview-loading"]'))
      .toBeNull();
    expect(video.controls).toBe(true);
    expect(video.playsInline).toBe(true);
    expect(video.paused).toBe(true);

    video.muted = true;
    await video.play();
    await expect.poll(() => video.currentTime).toBeGreaterThan(0);
    video.pause();
    video.currentTime = 0.5;
    await expect.poll(() => video.seeking).toBe(false);
    expect(video.currentTime).toBeCloseTo(0.5);

    await video.play();
    renderPreview(videoUri, false);
    expect(video.paused).toBe(true);
    renderPreview(videoUri, true);
    expect(videoElement()).toBe(video);
    expect(video.paused).toBe(true);

    await video.play();
    act(() => root?.unmount());
    root = null;
    expect(video.paused).toBe(true);
  });

  it("shows decode failures with a retry action and loads the next video", async () => {
    const invalidUri = URL.createObjectURL(new Blob(["invalid video"], { type: "video/mp4" }));
    objectUrls.push(invalidUri);
    renderPreview(invalidUri);
    await expect.poll(() => container.textContent).toContain("Unable to play this video.");
    const retry = container.querySelector('[role="button"]');
    if (!(retry instanceof HTMLElement)) throw new Error("Expected the retry button");
    expect(retry.textContent).toBe("Retry");
    act(() => retry.click());
    expect(videoElement().src).toBe(invalidUri);
    await expect.poll(() => container.textContent).toContain("Unable to play this video.");

    renderPreview(videoUri);
    await expect.poll(() => videoElement().videoWidth).toBe(64);
    expect(container.querySelector('[data-testid="video-file-preview-error"]')).toBeNull();
  });

  it("shows loading while the cached video URI is being prepared", () => {
    renderPreview(null);
    expect(container.textContent).toContain("Loading file...");
    expect(container.querySelector("video")).toBeNull();
  });
});
