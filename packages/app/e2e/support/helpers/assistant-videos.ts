import { truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import type { ArchiveTabAgent } from "./archive-tab";
import type { SeedDaemonClient, SeededWorkspace } from "./seed-client";
import { openAgentRoute } from "./mock-agent";

// 320x180 VP9, one second, solid colour.
//
// WebM and not MP4 on purpose: Playwright's bundled Chromium is built without
// proprietary codecs, so `canPlayType('video/mp4; codecs="avc1.42E01E"')` returns
// "" there and an H.264 fixture would fail for a codec reason while proving
// nothing about this code. Measured in that same build, this fixture fires
// loadedmetadata with videoWidth 320, videoHeight 180, readyState 4. MP4 playback
// is covered by hand against a Chromium that has the codecs.
const SMALL_WEBM = Buffer.from(
  "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAKFEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHYTbuMU6uEElTDZ1OsggEjTbuMU6uEHFO7a1OsggJv7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsirXsYMPQkBNgI1MYXZmNTguNzYuMTAwV0GNTGF2ZjU4Ljc2LjEwMESJiECPQAAAAAAAFlSua8auAQAAAAAAAD3XgQFzxYi4L63vkxB10pyBACK1nIN1bmSGhVZfVlA5g4EBI+ODhAvrwgDgAQAAAAAAAAqwggFAuoG0moECElTDZ0Cec3MBAAAAAAAAJ2PAgGfIAQAAAAAAABpFo4dFTkNPREVSRIeNTGF2ZjU4Ljc2LjEwMHNzAQAAAAAAAGNjwItjxYi4L63vkxB10mfIAQAAAAAAACZFo4dFTkNPREVSRIeZTGF2YzU4LjEzNC4xMDAgbGlidnB4LXZwOWfIokWjiERVUkFUSU9ORIeUMDA6MDA6MDEuMDAwMDAwMDAwAAAfQ7Z1QKLngQCjtIEAAICCSYNCABPwCzYAOCQcGFgAAJBiDEOvaO0QAABnGeb2kKNMT9mvLWIfm4OJEs/46QCjmYEAyACGAECSnABLAAAEYNWAAF6STnF7C5yjmIEBkACGAECSnABV4AADYAAAXpJOcXsLnKOYgQJYAIYAQJKcAE1AAANgAABekk5xewuco5iBAyAAhgBAkpwATIAAA2AAAF6STnF7C5wcU7trkbuPs4EAt4r3gQHxggHH8IED",
  "base64",
);

// Comfortably past MAX_INLINE_VIDEO_BYTES. Written sparse, so the daemon's stat
// sees the full size while the disk sees almost nothing.
const OVERSIZED_VIDEO_BYTES = 51 * 1024 * 1024;

export const VIDEO_TOO_LARGE_MESSAGE = "File is too large to display";

export interface AssistantVideoFixture {
  alt: string;
  height: number;
  relativePath: string;
  width: number;
}

export async function createSmallAssistantWebm(
  workspace: SeededWorkspace,
  input: { alt: string; fileName: string },
): Promise<AssistantVideoFixture> {
  await writeFile(path.join(workspace.repoPath, input.fileName), SMALL_WEBM);
  return {
    alt: input.alt,
    height: 180,
    relativePath: input.fileName,
    width: 320,
  };
}

export async function createOversizedAssistantVideo(
  workspace: SeededWorkspace,
  input: { alt: string; fileName: string },
): Promise<AssistantVideoFixture> {
  const filePath = path.join(workspace.repoPath, input.fileName);
  await writeFile(filePath, SMALL_WEBM);
  await truncate(filePath, OVERSIZED_VIDEO_BYTES);
  return {
    alt: input.alt,
    height: 0,
    relativePath: input.fileName,
    width: 0,
  };
}

export async function emitSettledAssistantVideo(
  client: SeedDaemonClient,
  agent: ArchiveTabAgent,
  video: AssistantVideoFixture,
): Promise<void> {
  // The mock provider echoes any image-syntax Markdown back as a settled turn,
  // which is exactly how an agent references a file it just produced.
  await client.sendAgentMessage(
    agent.id,
    `Emit settled assistant image Markdown: ![${video.alt}](${video.relativePath})`,
  );
  const result = await client.waitForFinish(agent.id, 30_000);
  if (result.status !== "idle" || result.final?.lastError) {
    throw new Error(
      `Assistant video agent did not settle: ${result.final?.lastError ?? result.status}`,
    );
  }
}

export async function openAssistantVideoTimeline(
  page: Page,
  agent: ArchiveTabAgent,
): Promise<void> {
  await openAgentRoute(page, { workspaceId: agent.workspaceId, agentId: agent.id });
}

export async function expectAssistantVideoPlayable(
  page: Page,
  video: AssistantVideoFixture,
): Promise<void> {
  const player = page.getByTestId("assistant-video").first();
  await expect(player).toBeVisible({ timeout: 30_000 });

  // readyState >= HAVE_METADATA means the browser decoded the container it was
  // handed, not merely that an element was mounted.
  await expect
    .poll(
      async () =>
        player.evaluate((element) => {
          const media = element as HTMLVideoElement;
          return media.readyState >= 1
            ? {
                height: media.videoHeight,
                width: media.videoWidth,
                blob: media.currentSrc.startsWith("blob:"),
              }
            : null;
        }),
      { timeout: 30_000 },
    )
    .toEqual({ height: video.height, width: video.width, blob: true });
}

export async function expectAssistantVideoRefused(
  page: Page,
  input: { message: string; fileName: string },
): Promise<void> {
  await expect(page.getByText(input.message, { exact: false }).first()).toBeVisible({
    timeout: 30_000,
  });
  // Naming the file is the point: the reason alone does not say which video.
  await expect(page.getByText(input.fileName, { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId("assistant-video")).toHaveCount(0);
}
