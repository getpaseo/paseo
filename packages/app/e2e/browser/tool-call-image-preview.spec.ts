import { copyFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import { openAgentRoute } from "../support/helpers/mock-agent";
import { seedWorkspace } from "../support/helpers/seed-client";

type WebSocketMessage = string | Buffer;

function mapReadToolEvent(message: WebSocketMessage, agentId: string, imagePath: string) {
  const raw = typeof message === "string" ? message : message.toString("utf8");
  let envelope: {
    type?: string;
    message?: {
      type?: string;
      payload?: {
        agentId?: string;
        event?: {
          type?: string;
          item?: {
            type?: string;
            name?: string;
            status?: string;
            detail?: unknown;
          };
        };
      };
    };
  };
  try {
    envelope = JSON.parse(raw);
  } catch {
    return message;
  }
  if (envelope.type !== "session" || envelope.message?.type !== "agent_stream") {
    return message;
  }
  const payload = envelope.message.payload;
  const item = payload?.event?.item;
  if (
    payload?.agentId !== agentId ||
    payload.event?.type !== "timeline" ||
    item?.type !== "tool_call" ||
    item.name !== "read"
  ) {
    return message;
  }
  item.detail = {
    type: "read",
    filePath: imagePath,
    ...(item.status === "completed" ? { content: "Read image file [image/png]" } : {}),
  };
  return JSON.stringify(envelope);
}

for (const level of ["detailed", "overview"] as const) {
  test(`renders a read image directly in the ${level} timeline`, async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const workspace = await seedWorkspace({ repoPrefix: `tool-read-image-${level}-` });
    try {
      const imagePath = path.join(workspace.repoPath, "read-preview.png");
      await copyFile(path.resolve(__dirname, "../../public/pwa-icon-192.png"), imagePath);
      const agent = await workspace.client.createAgent({
        provider: "mock",
        model: "ten-second-stream",
        modeId: "load-test",
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: "Read image preview",
      });
      await workspace.client.waitForAgentUpsert(agent.id, (snapshot) => snapshot.status === "idle");
      await page.addInitScript((detailLevel) => {
        localStorage.setItem(
          "@paseo:app-settings",
          JSON.stringify({ toolCallDetailLevel: detailLevel }),
        );
      }, level);
      if (level === "overview") {
        await page.setViewportSize({ width: 390, height: 780 });
      }
      await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
        const server = ws.connectToServer();
        ws.onMessage((message) => server.send(message));
        server.onMessage((message) => ws.send(mapReadToolEvent(message, agent.id, imagePath)));
      });
      await openAgentRoute(page, { workspaceId: workspace.workspaceId, agentId: agent.id });
      await workspace.client.sendAgentMessage(agent.id, "Show a read tool call.");

      const rendered = page.getByRole("img", { name: imagePath });
      await expect(rendered).toBeVisible({ timeout: 30_000 });
      await expect
        .poll(async () =>
          rendered.evaluate((element) => {
            const imageElement = element.querySelector("img");
            return imageElement?.complete
              ? { width: imageElement.naturalWidth, height: imageElement.naturalHeight }
              : null;
          }),
        )
        .toEqual({ width: 192, height: 192 });
      await workspace.client.waitForFinish(agent.id, 30_000);
      const imageCard = page.getByTestId("tool-call-badge").filter({ has: rendered }).last();
      await imageCard.evaluate((element) => element.scrollIntoView({ block: "center" }));
      await expect(imageCard).toBeVisible();
      const thumbnailBounds = await rendered.last().boundingBox();
      expect(thumbnailBounds).not.toBeNull();
      expect(thumbnailBounds!.width).toBeGreaterThanOrEqual(150);
      expect(thumbnailBounds!.width).toBeLessThanOrEqual(160);
      expect(thumbnailBounds!.height).toBeGreaterThanOrEqual(150);
      expect(thumbnailBounds!.height).toBeLessThanOrEqual(160);
      await imageCard.screenshot({ path: testInfo.outputPath(`read-image-card-${level}.png`) });
      await page.screenshot({ path: testInfo.outputPath(`read-image-${level}.png`) });
      await imageCard.getByRole("button", { name: "Open image attachment" }).click();
      const lightboxImage = page.getByTestId("attachment-lightbox-image");
      await expect(lightboxImage).toBeVisible();
      const zoomedContent = page
        .getByTestId("attachment-lightbox-canvas")
        .locator(":scope > div")
        .first();
      const initialWidth = (await zoomedContent.boundingBox())?.width ?? 0;
      expect(initialWidth).toBeGreaterThan(0);
      await page.getByRole("button", { name: "Zoom in", exact: true }).click();
      await expect
        .poll(async () => (await zoomedContent.boundingBox())?.width ?? 0)
        .toBeGreaterThan(initialWidth);
      await page.getByRole("button", { name: "Zoom out", exact: true }).click();
      await page.keyboard.press("Escape");
      await expect(lightboxImage).toHaveCount(0);
    } finally {
      await workspace.cleanup();
    }
  });
}
