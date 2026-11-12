import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { expectAgentIdle } from "../support/helpers/agent-stream";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

// A long user message paints capped, with its fade and Show more, in the frame it mounts in. These
// tests sample every painted frame from before the chat opens and require each long message to
// show one state, the settled one, for its whole life on screen.

interface PreviewFrame {
  height: number;
  fade: boolean;
  control: string | null;
}

declare global {
  interface Window {
    __previewFrames?: Record<string, PreviewFrame[]>;
  }
}

function longPrompt(name: string) {
  return Array.from({ length: 40 }, (_, line) => `${name} line ${line + 1}`).join("\n");
}

async function recordPreviewFrames(page: Page) {
  await page.addInitScript(() => {
    const frames: Record<string, PreviewFrame[]> = {};
    window.__previewFrames = frames;
    const sample = () => {
      for (const row of document.querySelectorAll('[data-testid="user-message"]')) {
        const rect = row.getBoundingClientRect();
        if (rect.height === 0) continue;
        const text = row.querySelector('[data-message-text="true"]');
        if (!text) continue;
        const name = (text.textContent ?? "").split(" line ")[0];
        // The preview is the ancestor that carries the height cap; the fade paints inside it.
        let preview = text.parentElement;
        while (preview && preview !== row && getComputedStyle(preview).maxHeight === "none") {
          preview = preview.parentElement;
        }
        const control = [...row.querySelectorAll("*")].find(
          (node) => node.children.length === 0 && /^Show (more|less)$/.test(node.textContent ?? ""),
        );
        const frame = {
          height: Math.round(rect.height),
          fade: preview !== null && preview !== row && preview.querySelector("svg") !== null,
          control: control?.textContent ?? null,
        };
        const seen = (frames[name] ??= []);
        if (JSON.stringify(seen.at(-1)) !== JSON.stringify(frame)) seen.push(frame);
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

async function expectPaintedCollapsedFromFirstFrame(page: Page, name: string) {
  const message = page.getByTestId("user-message").filter({ hasText: `${name} line 1` });
  await expect(message.getByRole("button", { name: "Show more" })).toBeVisible();
  // Let any late measurement land before reading the frames.
  await page.waitForTimeout(500);
  const frames = await page.evaluate((key) => window.__previewFrames?.[key] ?? [], name);
  expect(frames).toEqual([{ height: expect.any(Number), fade: true, control: "Show more" }]);
}

test.describe("long user message preview", () => {
  test("opening a chat paints its long message collapsed from the first frame", async ({
    page,
  }) => {
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "user-message-open-",
      title: "Preview open",
      initialPrompt: longPrompt("Opened prompt"),
    });
    try {
      await agent.client.waitForFinish(agent.agentId, 30_000);
      await recordPreviewFrames(page);
      await openAgentRoute(page, agent);
      await expectPaintedCollapsedFromFirstFrame(page, "Opened prompt");

      await page.reload();
      await expectPaintedCollapsedFromFirstFrame(page, "Opened prompt");
    } finally {
      await agent.cleanup();
    }
  });

  test("a long message arriving in an open chat paints collapsed from the first frame", async ({
    page,
  }) => {
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "user-message-arrive-",
      title: "Preview arrive",
      initialPrompt: "short",
    });
    try {
      await agent.client.waitForFinish(agent.agentId, 30_000);
      await recordPreviewFrames(page);
      await openAgentRoute(page, agent);
      await expectAgentIdle(page);

      await agent.client.sendAgentMessage(agent.agentId, longPrompt("Arrived prompt"));
      await expectPaintedCollapsedFromFirstFrame(page, "Arrived prompt");
    } finally {
      await agent.cleanup();
    }
  });

  test("a long message that arrived while its tab was hidden paints collapsed on return", async ({
    page,
  }) => {
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "user-message-hidden-",
      title: "Preview first",
      initialPrompt: "short",
    });
    try {
      await agent.client.createAgent({
        provider: "mock",
        cwd: agent.cwd,
        workspaceId: agent.workspaceId,
        title: "Preview second",
        modeId: "load-test",
        model: "e2e-fast-stream",
      });
      await agent.client.waitForFinish(agent.agentId, 30_000);
      await recordPreviewFrames(page);
      await openAgentRoute(page, agent);
      await expectAgentIdle(page);

      await page.getByRole("button", { name: "Preview second", exact: true }).click();
      await agent.client.sendAgentMessage(agent.agentId, longPrompt("Hidden prompt"));
      await agent.client.waitForFinish(agent.agentId, 30_000);
      await page.getByRole("button", { name: "Preview first", exact: true }).click();
      await expectPaintedCollapsedFromFirstFrame(page, "Hidden prompt");
    } finally {
      await agent.cleanup();
    }
  });
});
