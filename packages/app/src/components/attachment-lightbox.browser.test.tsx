import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { persistAttachmentFromBlob } from "@/attachments/service";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { i18n } from "@/i18n/i18next";
import { WindowLayoutProvider } from "@/window-layout";
import { AttachmentLightbox, type ImageLightboxSource } from "./attachment-lightbox";

interface FrameSample {
  image: { x: number; y: number; width: number; height: number } | null;
  error: boolean;
}

function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function createPng(width: number, height: number): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D context unavailable");
  context.fillStyle = "#3a7";
  context.fillRect(0, 0, width, height);
  return canvas.convertToBlob({ type: "image/png" });
}

function noop() {}

/** What the next paint will show: the lightbox image box, and whether the error state is up. */
function sampleFrame(): FrameSample {
  const image = document.querySelector('[data-testid="attachment-lightbox-image"]');
  const rect = image?.getBoundingClientRect();
  const visible = rect && rect.width > 0 && rect.height > 0;
  return {
    image: visible
      ? {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        }
      : null,
    error: (document.body.textContent ?? "").includes("Couldn't load image"),
  };
}

/** Samples every frame from the open until the image has held one box for 20 frames. */
async function recordOpening(open: () => void): Promise<FrameSample[]> {
  const samples: FrameSample[] = [];
  open();
  let stableFrames = 0;
  for (let frame = 0; frame < 300 && stableFrames < 20; frame += 1) {
    await nextFrame();
    const sample = sampleFrame();
    const previous = samples.at(-1);
    stableFrames =
      sample.image && JSON.stringify(sample.image) === JSON.stringify(previous?.image)
        ? stableFrames + 1
        : 0;
    samples.push(sample);
  }
  return samples;
}

let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  vi.stubGlobal("React", React);
  await i18n.changeLanguage("en");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function expectOpeningPaintsOnlyTheFittedImage(source: ImageLightboxSource) {
  const samples = await recordOpening(() => {
    root.render(
      <SafeAreaProvider>
        <WindowLayoutProvider>
          <AttachmentLightbox source={source} onClose={noop} />
        </WindowLayoutProvider>
      </SafeAreaProvider>,
    );
  });
  const fitted = samples.at(-1)?.image;

  expect(fitted, "the image never settled").toBeTruthy();
  expect(samples.filter((sample) => sample.error)).toEqual([]);
  expect(
    samples.filter(
      (sample) => sample.image && JSON.stringify(sample.image) !== JSON.stringify(fitted),
    ),
  ).toEqual([]);
}

describe("AttachmentLightbox opening in the browser", () => {
  it("paints the fitted attachment image as its first image frame", async () => {
    const metadata = await persistAttachmentFromBlob({
      blob: await createPng(2400, 1600),
      mimeType: "image/png",
      fileName: "screenshot.png",
    });

    await expectOpeningPaintsOnlyTheFittedImage({ type: "attachment", metadata });
  });

  it("paints the fitted timeline image as its first image frame", async () => {
    const uri = URL.createObjectURL(await createPng(2400, 1600));

    await expectOpeningPaintsOnlyTheFittedImage({ type: "uri", uri });
  });
});
