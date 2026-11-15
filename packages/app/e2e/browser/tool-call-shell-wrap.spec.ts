import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { expectComposerVisible } from "../support/helpers/composer";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

const MOBILE_VIEWPORT = { width: 390, height: 844 };

// The mock agent's shell call is short; widen it in flight so its lines exceed a phone screen.
const MOCK_COMMAND = "node scripts/simulate-stream-burst.mjs";
const LONG_COMMAND =
  'rg --no-heading --line-number "useIsCompactFormFactor" packages/app/src/components --glob "!**/*.test.tsx" | sort | tail-marker';
const LONG_OUTPUT_LINE =
  "packages/app/src/components/agent-stream/timeline/a-component-with-a-long-name.tsx:42:  const isCompact = useIsCompactFormFactor();";

function widenShellCall(message: string | Buffer): string | Buffer {
  const raw = typeof message === "string" ? message : message.toString("utf8");
  if (!raw.includes(MOCK_COMMAND)) return message;
  const encode = (value: string) => JSON.stringify(value).slice(1, -1);
  return raw
    .replaceAll(encode(MOCK_COMMAND), encode(LONG_COMMAND))
    .replace(/\[burst\][^"]*?(?=")/g, encode(`${LONG_OUTPUT_LINE}\n${LONG_OUTPUT_LINE}`));
}

async function openMobileShellSheet(page: Page) {
  await page.setViewportSize(MOBILE_VIEWPORT);
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "tool-call-shell-wrap-",
    title: "Shell detail wrap e2e",
    initialPrompt: "Run the search.",
    model: "ten-second-stream",
  });
  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => ws.send(widenShellCall(message)));
  });
  await openAgentRoute(page, agent);
  await expectComposerVisible(page);
  const badge = page.getByTestId("tool-call-badge").filter({ hasText: "rg --no-heading" }).first();
  await expect(badge).toBeVisible({ timeout: 40_000 });
  await badge.click();
  return agent;
}

function shellText(page: Page): Locator {
  return page.locator("[data-pmono]").filter({ hasText: "tail-marker" }).last();
}

// Width of the shell text against the nearest ancestor that clips it horizontally.
async function measure(surface: Locator) {
  return surface.evaluate((element) => {
    const text = element.firstElementChild ?? element;
    let clip = element.parentElement;
    while (clip && getComputedStyle(clip).overflowX === "visible") clip = clip.parentElement;
    return {
      textWidth: text.getBoundingClientRect().width,
      clipWidth: clip?.clientWidth ?? window.innerWidth,
      viewportWidth: window.innerWidth,
    };
  });
}

test.describe("shell tool call details on mobile", () => {
  test("wraps long commands and output inside the mobile sheet", async ({ page }) => {
    const agent = await openMobileShellSheet(page);
    try {
      await expect(page.getByTestId("tool-call-sheet-close")).toBeVisible();
      const surface = shellText(page);
      await expect(surface).toBeVisible();
      const box = await measure(surface);
      expect(box.textWidth).toBeLessThanOrEqual(box.clipWidth);
      expect(box.textWidth).toBeLessThanOrEqual(box.viewportWidth);
    } finally {
      await agent.cleanup();
    }
  });
});
