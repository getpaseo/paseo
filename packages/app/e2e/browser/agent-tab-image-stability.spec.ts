import { expect, test as base } from "../support/fixtures";
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

test("reloading a timeline anchors near-tail assistant image growth", async ({
  imageWorkspace: workspace,
  page,
}) => {
  test.setTimeout(120_000);
  const image = await createSmallAssistantPng(workspace, {
    alt: "Reload geometry image",
    fileName: "reload-geometry-image.png",
  });
  const imageAgent = await createSettledMockAgent(workspace, "Reload image geometry");
  await emitSettledAssistantImage(workspace.client, imageAgent, image);
  await appendSettledTimelineTurns(workspace.client, imageAgent, 3);

  await page.addInitScript(
    ({ accessibleName }) => {
      interface ImageGeometryEvent {
        atMs: number;
        complete: boolean;
        height: number;
        naturalHeight: number;
        naturalWidth: number;
        scrollTop: number;
        width: number;
      }
      const state = {
        accessibleName,
        events: [] as ImageGeometryEvent[],
        mutationObserver: null as MutationObserver | null,
        resizeObserver: null as ResizeObserver | null,
        target: null as Element | null,
      };
      const record = () => {
        const target = state.target;
        if (!target) return;
        const imageElement =
          target instanceof HTMLImageElement ? target : target.querySelector("img");
        const scroll = target.closest('[data-testid="agent-chat-scroll"]');
        const rect = target.getBoundingClientRect();
        const event: ImageGeometryEvent = {
          atMs: performance.now(),
          complete: imageElement?.complete ?? false,
          height: rect.height,
          naturalHeight: imageElement?.naturalHeight ?? 0,
          naturalWidth: imageElement?.naturalWidth ?? 0,
          scrollTop: scroll instanceof HTMLElement ? scroll.scrollTop : -1,
          width: rect.width,
        };
        const previous = state.events.at(-1);
        if (
          !previous ||
          previous.complete !== event.complete ||
          previous.height !== event.height ||
          previous.naturalHeight !== event.naturalHeight ||
          previous.naturalWidth !== event.naturalWidth ||
          previous.scrollTop !== event.scrollTop ||
          previous.width !== event.width
        ) {
          state.events.push(event);
        }
      };
      const inspect = () => {
        const target = Array.from(document.querySelectorAll('[role="img"]')).find(
          (element) => element.getAttribute("aria-label") === accessibleName,
        );
        if (!target || target === state.target) {
          record();
          return;
        }
        state.target = target;
        state.resizeObserver?.disconnect();
        state.resizeObserver = new ResizeObserver(record);
        state.resizeObserver.observe(target);
        record();
      };
      const start = () => {
        state.mutationObserver = new MutationObserver(inspect);
        state.mutationObserver.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ["src", "style"],
          childList: true,
          subtree: true,
        });
        inspect();
      };
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start, { once: true });
      } else {
        start();
      }
      (
        window as unknown as {
          __paseoReloadImageGeometry?: typeof state;
        }
      ).__paseoReloadImageGeometry = state;
    },
    { accessibleName: image.alt },
  );

  await openAssistantImageTimeline(page, imageAgent);
  await expectAssistantImageRendered(page, image);
  await page.reload();
  await expectAssistantImageRendered(page, image);
  await page.waitForTimeout(500);

  const events = await page.evaluate(() => {
    const state = (
      window as unknown as {
        __paseoReloadImageGeometry?: { events: Array<unknown> };
      }
    ).__paseoReloadImageGeometry;
    if (!state) throw new Error("Reload image geometry observer was not installed");
    return state.events;
  });
  const geometryEvents = events as Array<{ height: number; scrollTop: number }>;
  const initialGeometry = geometryEvents.find((event) => event.height > 0);
  if (!initialGeometry)
    throw new Error(`Image geometry was never measurable: ${JSON.stringify(events)}`);
  const expandedGeometry = geometryEvents.find((event) => event.height > initialGeometry.height);
  if (!expandedGeometry)
    throw new Error(`Image geometry never expanded: ${JSON.stringify(events)}`);
  expect(expandedGeometry.scrollTop, JSON.stringify(events)).toBeGreaterThan(
    initialGeometry.scrollTop,
  );
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
