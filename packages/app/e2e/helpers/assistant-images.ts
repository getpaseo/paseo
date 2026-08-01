import { writeFile } from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { expect, type Page } from "@playwright/test";
import type { ArchiveTabAgent } from "./archive-tab";
import { openWorkspaceWithAgents } from "./archive-tab";
import { submitMessage } from "./composer";
import type { SeedDaemonClient, SeededWorkspace } from "./seed-client";
import { openAgentRoute } from "./mock-agent";
import { rememberTimelineViewport, userScrollsTimelineToHistoryStart } from "./timeline-pagination";

const IMAGE_PREVIEW_ERROR = "Unable to load image preview.";
const SMALL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
);
const TEN_MEBIBYTES = 10 * 1024 * 1024;

export interface AssistantImageFixture {
  alt: string;
  height: number;
  relativePath: string;
  size: number;
  width: number;
}

export async function createSmallAssistantPng(
  workspace: SeededWorkspace,
  input: { alt: string; fileName: string },
): Promise<AssistantImageFixture> {
  await writeFile(path.join(workspace.repoPath, input.fileName), SMALL_PNG);
  return {
    alt: input.alt,
    height: 1,
    relativePath: input.fileName,
    size: SMALL_PNG.byteLength,
    width: 1,
  };
}

export async function createNearTenMegabyteAssistantPng(
  workspace: SeededWorkspace,
  input: { alt: string; fileName: string },
): Promise<AssistantImageFixture> {
  const width = 2_048;
  const height = 1_280;
  const bytes = encodeDeterministicPng(width, height);
  if (bytes.byteLength < TEN_MEBIBYTES * 0.95 || bytes.byteLength > TEN_MEBIBYTES * 1.05) {
    throw new Error(`Expected a PNG near 10 MiB, encoded ${bytes.byteLength} bytes`);
  }
  await writeFile(path.join(workspace.repoPath, input.fileName), bytes);
  return {
    alt: input.alt,
    height,
    relativePath: input.fileName,
    size: bytes.byteLength,
    width,
  };
}

export async function createSettledMockAgent(
  workspace: SeededWorkspace,
  title: string,
): Promise<ArchiveTabAgent> {
  const agent = await workspace.client.createAgent({
    provider: "mock",
    model: "ten-second-stream",
    modeId: "load-test",
    cwd: workspace.repoPath,
    workspaceId: workspace.workspaceId,
    title,
  });
  await workspace.client.waitForAgentUpsert(
    agent.id,
    (snapshot) => snapshot.status === "idle",
    30_000,
  );
  return {
    id: agent.id,
    title,
    cwd: workspace.repoPath,
    workspaceId: workspace.workspaceId,
  };
}

export async function emitSettledAssistantImage(
  client: SeedDaemonClient,
  agent: ArchiveTabAgent,
  image: AssistantImageFixture,
): Promise<void> {
  await client.sendAgentMessage(
    agent.id,
    `Emit settled assistant image Markdown: ![${image.alt}](${image.relativePath})`,
  );
  const result = await client.waitForFinish(agent.id, 30_000);
  if (result.status !== "idle" || result.final?.lastError) {
    throw new Error(
      `Assistant image agent did not settle: ${result.final?.lastError ?? result.status}`,
    );
  }
}

export async function appendSettledTimelineTurns(
  client: SeedDaemonClient,
  agent: ArchiveTabAgent,
  count: number,
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await client.sendAgentMessage(
      agent.id,
      `image-history-turn-${index}: emit 1 coalesced agent stream updates`,
    );
    const result = await client.waitForFinish(agent.id, 30_000);
    if (result.status !== "idle" || result.final?.lastError) {
      throw new Error(
        `Assistant image history turn did not settle: ${result.final?.lastError ?? result.status}`,
      );
    }
  }
}

export async function expectAssistantImageRendered(
  page: Page,
  image: AssistantImageFixture,
): Promise<void> {
  const rendered = page.getByRole("img", { name: image.alt }).first();
  await expect(rendered).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () =>
      rendered.evaluate((element) => {
        const imageElement =
          element instanceof HTMLImageElement ? element : element.querySelector("img");
        return imageElement?.complete
          ? { height: imageElement.naturalHeight, width: imageElement.naturalWidth }
          : null;
      }),
    )
    .toEqual({ height: image.height, width: image.width });
}

export async function switchAwayAndBackWithoutImageInstability(
  page: Page,
  input: {
    image: AssistantImageFixture;
    imageAgent: ArchiveTabAgent;
    otherAgent: ArchiveTabAgent;
  },
): Promise<void> {
  await beginVisibleImageStabilityObservation(page, input.image.alt, input.imageAgent.id);
  await selectSettledAgentTab(page, input.otherAgent);
  await selectSettledAgentTab(page, input.imageAgent);
  await expectAssistantImageRendered(page, input.image);
  await expectNoVisibleImageInstability(page);
}

export async function openExistingImageAgentTabs(
  page: Page,
  input: { imageAgent: ArchiveTabAgent; otherAgent: ArchiveTabAgent },
): Promise<void> {
  await openWorkspaceWithAgents(page, [input.otherAgent, input.imageAgent]);
}

export async function openAssistantImageTimeline(
  page: Page,
  agent: ArchiveTabAgent,
): Promise<void> {
  await openAgentRoute(page, { workspaceId: agent.workspaceId, agentId: agent.id });
}

export async function expectAssistantImageNotMounted(
  page: Page,
  image: AssistantImageFixture,
): Promise<void> {
  await expect(page.getByRole("img", { name: image.alt })).toHaveCount(0);
}

export async function userPagesUntilAssistantImageRenders(
  page: Page,
  image: AssistantImageFixture,
): Promise<void> {
  const rendered = page.getByRole("img", { name: image.alt });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if ((await rendered.count()) > 0) {
      await expectAssistantImageRendered(page, image);
      return;
    }
    const previous = await rememberTimelineViewport(page);
    await userScrollsTimelineToHistoryStart(page);
    await expect
      .poll(async () => (await rememberTimelineViewport(page)).scrollHeight)
      .toBeGreaterThan(previous.scrollHeight);
  }
  await expectAssistantImageRendered(page, image);
}

export async function remountAndRecoverAssistantImageFromHistory(
  page: Page,
  image: AssistantImageFixture,
): Promise<void> {
  await page.reload();
  await userPagesUntilAssistantImageRenders(page, image);
}

export async function sendFollowUpAndExpectVisibleResponse(
  page: Page,
  input: { prompt: string; response: string },
): Promise<void> {
  await submitMessage(page, input.prompt);
  await expect(page.getByText(input.prompt, { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(input.response, { exact: true })).toBeVisible({ timeout: 30_000 });
}

async function selectSettledAgentTab(page: Page, agent: ArchiveTabAgent): Promise<void> {
  const tab = page.getByRole("button", { name: agent.title, exact: true });
  await tab.click();
  await expect(page).toHaveTitle(agent.title);
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[data-testid="agent-chat-scroll"]:visible').first()).toBeVisible({
    timeout: 30_000,
  });
}

async function beginVisibleImageStabilityObservation(
  page: Page,
  alt: string,
  imageAgentId: string,
): Promise<void> {
  await page.evaluate(
    ({ accessibleName, errorText, tabTestId }) => {
      const record = {
        errorSeen: false,
        missingSeen: false,
        inspect: () => undefined,
        observer: null as MutationObserver | null,
      };
      const isVisible = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      record.inspect = () => {
        record.errorSeen ||= Array.from(document.querySelectorAll("*")).some(
          (element) =>
            element.children.length === 0 &&
            element.textContent?.trim() === errorText &&
            isVisible(element),
        );
        const imageTab = document.querySelector(`[data-testid="${tabTestId}"]`);
        if (imageTab?.getAttribute("aria-selected") !== "true") return;
        const imageVisible = Array.from(document.querySelectorAll('[role="img"]')).some(
          (element) => element.getAttribute("aria-label") === accessibleName && isVisible(element),
        );
        record.missingSeen ||= !imageVisible;
      };
      record.observer = new MutationObserver(record.inspect);
      record.observer.observe(document.body, {
        attributes: true,
        childList: true,
        subtree: true,
        characterData: true,
      });
      record.inspect();
      (
        window as unknown as {
          __paseoAssistantImageObservation?: typeof record;
        }
      ).__paseoAssistantImageObservation = record;
    },
    {
      accessibleName: alt,
      errorText: IMAGE_PREVIEW_ERROR,
      tabTestId: `workspace-tab-agent_${imageAgentId}`,
    },
  );
}

async function expectNoVisibleImageInstability(page: Page): Promise<void> {
  const observation = await page.evaluate(() => {
    const owner = window as unknown as {
      __paseoAssistantImageObservation?: {
        errorSeen: boolean;
        missingSeen: boolean;
        inspect(): void;
        observer: MutationObserver | null;
      };
    };
    const record = owner.__paseoAssistantImageObservation;
    if (!record) throw new Error("Assistant image stability observation was not started");
    record.inspect();
    record.observer?.disconnect();
    delete owner.__paseoAssistantImageObservation;
    return { errorSeen: record.errorSeen, missingSeen: record.missingSeen };
  });
  expect(observation).toEqual({ errorSeen: false, missingSeen: false });
}

function encodeDeterministicPng(width: number, height: number): Buffer {
  const stride = width * 4 + 1;
  const scanlines = Buffer.allocUnsafe(stride * height);
  let state = 0x9e3779b9;
  for (let row = 0; row < height; row += 1) {
    const rowOffset = row * stride;
    scanlines[rowOffset] = 0;
    for (let offset = 1; offset < stride; offset += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      scanlines[rowOffset + offset] = state & 0xff;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines, { level: 0 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.allocUnsafe(12 + data.byteLength);
  chunk.writeUInt32BE(data.byteLength, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.byteLength);
  return chunk;
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
