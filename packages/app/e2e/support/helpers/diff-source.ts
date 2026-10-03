import type { Page } from "@playwright/test";

export interface DiffPaintSamples {
  gutter: number[];
  code: number[];
  opposite: number[];
}

export interface DiffTextOffsets {
  startOffset: number;
  endOffset: number;
}

export async function dragExactAddedText(
  page: Page,
  offsets: DiffTextOffsets,
  fileIndex = 0,
): Promise<void> {
  const body = page.getByTestId(`diff-file-${fileIndex}-body`);
  const canvas = page.getByTestId("git-diff-canvas");
  const [bodyBounds, metrics] = await Promise.all([
    body.boundingBox(),
    canvas.evaluate((element) => {
      const style = getComputedStyle(element);
      const fontSize = Number.parseFloat(style.fontSize);
      const measurementCanvas = document.createElement("canvas");
      const context = measurementCanvas.getContext("2d")!;
      context.font = `${fontSize}px ${style.fontFamily}`;
      return { fontSize, characterWidth: context.measureText("A").width };
    }),
  ]);
  if (!bodyBounds) throw new Error("Expanded diff body has no bounds");
  const lineHeight = Math.round(metrics.fontSize * 1.5);
  const gutterWidth = Math.max(2, String(1).length) * Math.ceil(metrics.fontSize * 0.62) + 12;
  const textLeft = bodyBounds.x + gutterWidth + 8;
  await page.mouse.move(
    textLeft + offsets.startOffset * metrics.characterWidth + 1,
    bodyBounds.y + lineHeight * 1.5,
  );
  await page.mouse.down();
  await page.mouse.move(
    textLeft + offsets.endOffset * metrics.characterWidth - 1,
    bodyBounds.y + lineHeight * 1.5,
    { steps: 8 },
  );
  await page.mouse.up();
}

export async function readSelectionPaintSamples(
  page: Page,
  side: "unified" | "right" = "unified",
): Promise<DiffPaintSamples> {
  return page.getByTestId("diff-file-0-body").evaluate((body, selectedSide) => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="git-diff-canvas"]')!;
    const bodyBounds = body.getBoundingClientRect();
    const canvasBounds = canvas.getBoundingClientRect();
    const scaleX = canvas.width / canvasBounds.width;
    const scaleY = canvas.height / canvasBounds.height;
    const context = canvas.getContext("2d")!;
    const sample = (left: number, top: number, width: number, height: number) =>
      Array.from(
        context.getImageData(
          Math.round((left - canvasBounds.left) * scaleX),
          Math.round((top - canvasBounds.top) * scaleY),
          Math.max(1, Math.round(width * scaleX)),
          Math.max(1, Math.round(height * scaleY)),
        ).data,
      );
    const columnLeft =
      selectedSide === "right" ? bodyBounds.left + bodyBounds.width / 2 : bodyBounds.left;
    return {
      gutter: sample(columnLeft + 2, bodyBounds.top + 24, 8, 8),
      code: sample(columnLeft + 80, bodyBounds.top + 24, 80, 10),
      opposite: sample(bodyBounds.left + 80, bodyBounds.top + 24, 80, 10),
    };
  }, side);
}
