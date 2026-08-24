import { test as base } from "../support/fixtures";
import { createSettledMockAgent } from "../support/helpers/assistant-images";
import {
  createOversizedAssistantVideo,
  createSmallAssistantWebm,
  emitSettledAssistantVideo,
  expectAssistantVideoPlayable,
  expectAssistantVideoRefused,
  openAssistantVideoTimeline,
  VIDEO_TOO_LARGE_MESSAGE,
} from "../support/helpers/assistant-videos";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";

const test = base.extend<{ videoWorkspace: SeededWorkspace }>({
  videoWorkspace: async ({ page: _page }, provide) => {
    const workspace = await seedWorkspace({ repoPrefix: "assistant-video-" });
    try {
      await provide(workspace);
    } finally {
      await workspace.cleanup();
    }
  },
});

test("an assistant video in the timeline plays inline", async ({
  videoWorkspace: workspace,
  page,
}) => {
  test.setTimeout(120_000);
  const video = await createSmallAssistantWebm(workspace, {
    alt: "Recorded run",
    fileName: "recorded-run.webm",
  });
  const agent = await createSettledMockAgent(workspace, "Video timeline");
  await emitSettledAssistantVideo(workspace.client, agent, video);

  await openAssistantVideoTimeline(page, agent);
  await expectAssistantVideoPlayable(page, video);
});

test("a video past the inline ceiling falls back instead of loading", async ({
  videoWorkspace: workspace,
  page,
}) => {
  test.setTimeout(120_000);
  const video = await createOversizedAssistantVideo(workspace, {
    alt: "Long capture",
    fileName: "long-capture.mp4",
  });
  const agent = await createSettledMockAgent(workspace, "Oversized video timeline");
  await emitSettledAssistantVideo(workspace.client, agent, video);

  await openAssistantVideoTimeline(page, agent);
  // The daemon refuses on the file's stat, so nothing is transferred and no
  // player is mounted.
  await expectAssistantVideoRefused(page, {
    message: VIDEO_TOO_LARGE_MESSAGE,
    fileName: video.relativePath,
  });
});
