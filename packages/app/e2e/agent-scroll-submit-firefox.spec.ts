import { expect, test, type Page } from "@playwright/test";

const SERVER_ID =
  process.env.PLAYWRIGHT_REPRO_SERVER_ID ?? "srv_ETXtcjYRGrCI";
const AGENT_ID =
  process.env.PLAYWRIGHT_REPRO_AGENT_ID ??
  "3533e6c3-c0b3-4310-b85c-eb07cbb501a0";
const APP_BASE_URL = process.env.PLAYWRIGHT_REPRO_BASE_URL ?? "http://localhost:8081";
const DAEMON_ENDPOINT =
  process.env.PLAYWRIGHT_REPRO_DAEMON_ENDPOINT ?? "127.0.0.1:6767";
const SUBMIT_TEXT = process.env.PLAYWRIGHT_REPRO_MESSAGE ?? "hello";
const AGENT_URL = `${APP_BASE_URL}/h/${SERVER_ID}/agent/${AGENT_ID}`;
const NEAR_BOTTOM_THRESHOLD_PX = 64;

type ScrollMetrics = {
  offsetY: number;
  contentHeight: number;
  viewportHeight: number;
  distanceFromBottom: number;
};

test.use({ browserName: "firefox" });

function seedDaemonRegistryScript(params: {
  serverId: string;
  endpoint: string;
  nowIso: string;
}) {
  const daemon = {
    serverId: params.serverId,
    label: "localhost",
    connections: [
      {
        id: `direct:${params.endpoint}`,
        type: "direct",
        endpoint: params.endpoint,
      },
    ],
    preferredConnectionId: `direct:${params.endpoint}`,
    createdAt: params.nowIso,
    updatedAt: params.nowIso,
  };

  localStorage.setItem("@paseo:e2e", "1");
  localStorage.setItem("@paseo:daemon-registry", JSON.stringify([daemon]));
  localStorage.setItem(
    "@paseo:create-agent-preferences",
    JSON.stringify({
      serverId: params.serverId,
      provider: "codex",
      providerPreferences: {
        claude: { model: "haiku" },
        codex: { model: "gpt-5.1-codex-mini", thinkingOptionId: "low" },
      },
    })
  );
}

async function readScrollMetrics(page: Page): Promise<ScrollMetrics> {
  return page.getByTestId("agent-chat-scroll").evaluate((root: Element) => {
    const rootElement = root as HTMLElement;
    const candidates = [rootElement, ...Array.from(rootElement.querySelectorAll("*"))];
    const scrollElement =
      candidates.find(
        (element) =>
          element instanceof HTMLElement &&
          element.scrollHeight - element.clientHeight > 1
      ) ?? rootElement;

    const offsetY = Math.max(0, scrollElement.scrollTop);
    const contentHeight = Math.max(0, scrollElement.scrollHeight);
    const viewportHeight = Math.max(0, scrollElement.clientHeight);
    const distanceFromBottom = Math.max(
      0,
      contentHeight - (offsetY + viewportHeight)
    );

    return {
      offsetY,
      contentHeight,
      viewportHeight,
      distanceFromBottom,
    };
  });
}

async function scrollUpFromBottom(
  page: Page,
  pixels: number
): Promise<void> {
  await page.getByTestId("agent-chat-scroll").evaluate(
    (root: Element, amount: number) => {
      const rootElement = root as HTMLElement;
      const candidates = [
        rootElement,
        ...Array.from(rootElement.querySelectorAll("*")),
      ];
      const scrollElement =
        candidates.find(
          (element) =>
            element instanceof HTMLElement &&
            element.scrollHeight - element.clientHeight > 1
        ) ?? rootElement;

      const bottomOffset = Math.max(
        0,
        scrollElement.scrollHeight - scrollElement.clientHeight
      );
      scrollElement.scrollTop = Math.max(0, bottomOffset - amount);
    },
    pixels
  );
}

test("repro: submit while scrolled up should stay anchored to bottom (Firefox)", async ({
  page,
}, testInfo) => {
  const userAgent = await page.evaluate(() => navigator.userAgent);
  expect(userAgent).toContain("Firefox");

  await page.addInitScript(seedDaemonRegistryScript, {
    serverId: SERVER_ID,
    endpoint: DAEMON_ENDPOINT,
    nowIso: new Date().toISOString(),
  });

  await page.goto(AGENT_URL, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("agent-chat-scroll")).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByRole("textbox", { name: "Message agent..." })).toBeVisible({
    timeout: 60_000,
  });

  // Require enough history so the repro actually scrolls away from bottom.
  await expect
    .poll(async () => {
      const metrics = await readScrollMetrics(page);
      return Math.max(0, metrics.contentHeight - metrics.viewportHeight);
    })
    .toBeGreaterThan(300);

  await scrollUpFromBottom(page, 900);
  await page.waitForTimeout(250);
  const beforeSubmit = await readScrollMetrics(page);
  const beforePath = testInfo.outputPath("before-submit.png");
  await page.screenshot({ path: beforePath, fullPage: true });
  await testInfo.attach("before-submit", {
    path: beforePath,
    contentType: "image/png",
  });

  await page.getByRole("textbox", { name: "Message agent..." }).fill(SUBMIT_TEXT);
  await page.getByRole("textbox", { name: "Message agent..." }).press("Enter");
  await page.waitForTimeout(1200);

  const afterSubmit = await readScrollMetrics(page);
  const afterPath = testInfo.outputPath("after-submit.png");
  await page.screenshot({ path: afterPath, fullPage: true });
  await testInfo.attach("after-submit", {
    path: afterPath,
    contentType: "image/png",
  });
  await testInfo.attach("firefox-scroll-metrics", {
    body: JSON.stringify(
      {
        url: AGENT_URL,
        submitText: SUBMIT_TEXT,
        thresholdPx: NEAR_BOTTOM_THRESHOLD_PX,
        beforeScreenshot: beforePath,
        afterScreenshot: afterPath,
        beforeSubmit,
        afterSubmit,
      },
      null,
      2
    ),
    contentType: "application/json",
  });

  console.log(
    `[firefox-scroll-repro] ${JSON.stringify(
      {
        submitText: SUBMIT_TEXT,
        beforeSubmit,
        afterSubmit,
      },
      null,
      2
    )}`
  );

  expect(beforeSubmit.distanceFromBottom).toBeGreaterThan(NEAR_BOTTOM_THRESHOLD_PX);
  expect(afterSubmit.distanceFromBottom).toBeLessThanOrEqual(
    NEAR_BOTTOM_THRESHOLD_PX
  );
});
