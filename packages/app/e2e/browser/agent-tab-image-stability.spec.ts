import { test as base } from "../support/fixtures";
import {
  appendSettledTimelineTurns,
  createNearTenMegabyteAssistantPng,
  createSettledMockAgent,
  createSmallAssistantPng,
  emitSettledAssistantImage,
  expectAssistantImageNotMounted,
  expectAssistantImageRendered,
  openAssistantImageTimeline,
  openExistingImageAgentTabs,
  remountAndRecoverAssistantImageFromHistory,
  sendFollowUpAndExpectVisibleResponse,
  switchAwayAndBackWithoutImageInstability,
  userPagesUntilAssistantImageRenders,
} from "../support/helpers/assistant-images";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";

const test = base.extend<{ imageWorkspace: SeededWorkspace }>({
  imageWorkspace: async ({ page: _page }, provide) => {
    const workspace = await seedWorkspace({ repoPrefix: "agent-tab-image-stability-" });
    try {
      await provide(workspace);
    } finally {
      await workspace.cleanup();
    }
  },
});

test("switching between settled agent tabs keeps a real assistant PNG rendered", async ({
  imageWorkspace: workspace,
  page,
}) => {
  test.setTimeout(120_000);
  const image = await createSmallAssistantPng(workspace, {
    alt: "Real file image",
    fileName: "assistant-preview.png",
  });
  const imageAgent = await createSettledMockAgent(workspace, "Image timeline");
  const otherAgent = await createSettledMockAgent(workspace, "Other timeline");
  await emitSettledAssistantImage(workspace.client, imageAgent, image);

  await openExistingImageAgentTabs(page, { imageAgent, otherAgent });
  await expectAssistantImageRendered(page, image);
  await switchAwayAndBackWithoutImageInstability(page, { image, imageAgent, otherAgent });
});

test("a real assistant PNG remains reachable through pagination and remount", async ({
  imageWorkspace: workspace,
  page,
}) => {
  test.setTimeout(120_000);
  const image = await createSmallAssistantPng(workspace, {
    alt: "Paginated real file image",
    fileName: "paginated-assistant-preview.png",
  });
  const imageAgent = await createSettledMockAgent(workspace, "Paginated image timeline");
  await emitSettledAssistantImage(workspace.client, imageAgent, image);
  await appendSettledTimelineTurns(workspace.client, imageAgent, 40);

  await openAssistantImageTimeline(page, imageAgent);
  await expectAssistantImageNotMounted(page, image);
  await userPagesUntilAssistantImageRenders(page, image);
  await remountAndRecoverAssistantImageFromHistory(page, image);
});

test("a near-10 MiB real assistant PNG renders and the app remains responsive", async ({
  imageWorkspace: workspace,
  page,
}) => {
  test.setTimeout(180_000);
  const image = await createNearTenMegabyteAssistantPng(workspace, {
    alt: "Large real file image",
    fileName: "large-assistant-preview.png",
  });
  const imageAgent = await createSettledMockAgent(workspace, "Large image timeline");
  await emitSettledAssistantImage(workspace.client, imageAgent, image);

  await openAssistantImageTimeline(page, imageAgent);
  await expectAssistantImageRendered(page, image);
  await sendFollowUpAndExpectVisibleResponse(page, {
    prompt: "confirm responsiveness: emit 1 coalesced agent stream updates",
    response: "stress-update-0",
  });
});
