import { test, expect } from "../support/fixtures";
import { awaitAssistantMessage, expectAgentIdle } from "../support/helpers/agent-stream";
import { startRunningMockAgent, submitMessage } from "../support/helpers/composer";

test("keeps animated chat entries in the timeline layout", async ({ page }) => {
  const agent = await startRunningMockAgent(page, {
    prefix: "message-entry-layout-",
    model: "e2e-fast-stream",
    prompt: "First message for entry layout.",
  });
  try {
    await awaitAssistantMessage(page);
    await expectAgentIdle(page);

    const assistant = page.getByTestId("assistant-message").last();
    const footerAction = page.getByRole("button", { name: "Copy turn" }).last();
    const [assistantBox, footerBox] = await Promise.all([
      assistant.boundingBox(),
      footerAction.boundingBox(),
    ]);
    expect(assistantBox).not.toBeNull();
    expect(footerBox).not.toBeNull();
    expect(footerBox!.y).toBeGreaterThanOrEqual(assistantBox!.y + assistantBox!.height - 1);

    const secondPrompt = "Second message for entry layout.";
    await submitMessage(page, secondPrompt);
    const userMessage = page.getByTestId("user-message").filter({ hasText: secondPrompt }).last();
    await expect(userMessage).toBeVisible();
    const [currentFooterBox, userBox] = await Promise.all([
      footerAction.boundingBox(),
      userMessage.boundingBox(),
    ]);
    expect(currentFooterBox).not.toBeNull();
    expect(userBox).not.toBeNull();
    expect(userBox!.y).toBeGreaterThanOrEqual(currentFooterBox!.y + currentFooterBox!.height - 1);
  } finally {
    await agent.cleanup();
  }
});

test("keeps a submitted user message moving after transport acknowledgement", async ({ page }) => {
  const agent = await startRunningMockAgent(page, {
    prefix: "user-message-entry-motion-",
    model: "e2e-fast-stream",
    prompt: "First message before measuring the next entry.",
  });
  try {
    await awaitAssistantMessage(page);
    await expectAgentIdle(page);

    const prompt = "Measure this submitted message entry.";
    await page.evaluate((expectedText) => {
      const samples: Array<{ busy: string | null; opacity: number; transform: string }> = [];
      const startedAt = performance.now();
      const sample = () => {
        const message = Array.from(
          document.querySelectorAll<HTMLElement>('[data-testid="user-message"]'),
        ).find((candidate) => candidate.textContent?.includes(expectedText));
        if (message) {
          const entry = message.closest<HTMLElement>('[data-testid="stream-item"]');
          if (!entry) {
            throw new Error("Expected user message entry wrapper");
          }
          const style = getComputedStyle(entry);
          samples.push({
            busy: message.getAttribute("aria-busy"),
            opacity: Number.parseFloat(style.opacity),
            transform: style.transform,
          });
        }
        if (performance.now() - startedAt < 260) {
          requestAnimationFrame(sample);
          return;
        }
        Reflect.set(globalThis, "__userMessageEntrySamples", samples);
      };
      requestAnimationFrame(sample);
    }, prompt);

    await submitMessage(page, prompt);
    const message = page.getByTestId("user-message").filter({ hasText: prompt }).last();
    await expect(message).toHaveAttribute("aria-busy", "false", { timeout: 10_000 });
    await page.waitForTimeout(300);

    const [scrollBox, messageBox] = await Promise.all([
      page.getByTestId("agent-chat-scroll").boundingBox(),
      message.boundingBox(),
    ]);
    expect(scrollBox).not.toBeNull();
    expect(messageBox).not.toBeNull();
    expect(messageBox!.y + messageBox!.height).toBeLessThanOrEqual(
      scrollBox!.y + scrollBox!.height + 1,
    );

    const samples = await page.evaluate(
      () =>
        Reflect.get(globalThis, "__userMessageEntrySamples") as Array<{
          busy: string | null;
          opacity: number;
          transform: string;
        }>,
    );
    const acknowledgedMotionSamples = samples.filter(
      (sample) => sample.busy === "false" && sample.opacity > 0 && sample.opacity < 0.999,
    );
    expect(
      acknowledgedMotionSamples.length,
      `expected acknowledged entry motion, received ${JSON.stringify(samples)}`,
    ).toBeGreaterThan(1);
    expect(
      new Set(acknowledgedMotionSamples.map((sample) => sample.transform)).size,
    ).toBeGreaterThan(1);
  } finally {
    await agent.cleanup();
  }
});

test("animates the running progress, fork action, and elapsed time as one chat entry", async ({
  page,
}) => {
  const agent = await startRunningMockAgent(page, {
    prefix: "turn-footer-entry-motion-",
    model: "e2e-fast-stream",
    prompt: "First message before measuring the next progress entry.",
  });
  try {
    await awaitAssistantMessage(page);
    await expectAgentIdle(page);

    await page.evaluate(() => {
      const samples: Array<{ opacity: number; transform: string }> = [];
      const startedAt = performance.now();
      const sample = () => {
        const footer = Array.from(
          document.querySelectorAll<HTMLElement>('[data-testid="turn-footer-entry-motion"]'),
        ).find((candidate) => candidate.querySelector('[data-testid="turn-working-indicator"]'));
        if (footer) {
          const style = getComputedStyle(footer);
          samples.push({
            opacity: Number.parseFloat(style.opacity),
            transform: style.transform,
          });
        }
        if (performance.now() - startedAt < 500) {
          requestAnimationFrame(sample);
          return;
        }
        Reflect.set(globalThis, "__turnFooterEntrySamples", samples);
      };
      requestAnimationFrame(sample);
    });

    await submitMessage(page, "Measure the running footer entry.");
    await expect(page.getByTestId("turn-working-indicator")).toBeVisible();
    await expect(page.getByTestId("assistant-fork-menu-trigger").last()).toBeVisible();
    await expect(page.getByTestId("turn-working-elapsed")).toBeVisible();
    await page.waitForTimeout(550);

    const samples = await page.evaluate(
      () =>
        Reflect.get(globalThis, "__turnFooterEntrySamples") as Array<{
          opacity: number;
          transform: string;
        }>,
    );
    const movingSamples = samples.filter((sample) => sample.opacity > 0 && sample.opacity < 0.999);
    expect(movingSamples.length).toBeGreaterThan(2);
    expect(new Set(movingSamples.map((sample) => sample.transform)).size).toBeGreaterThan(2);
  } finally {
    await agent.cleanup();
  }
});

test("keeps the running fork control settled after it first appears", async ({ page }) => {
  const agent = await startRunningMockAgent(page, {
    prefix: "turn-footer-fork-settled-",
    model: "e2e-fast-stream",
    prompt: "First message before measuring a settled fork control.",
  });
  try {
    await awaitAssistantMessage(page);
    await expectAgentIdle(page);

    await submitMessage(page, "Keep the fork control still after it appears.");
    const fork = page.getByTestId("assistant-fork-menu-trigger").last();
    const footer = page.getByTestId("turn-footer-entry-motion").last();
    await expect(page.getByTestId("turn-working-indicator")).toBeVisible();
    await expect(fork).toBeVisible();
    await expect(footer).toHaveCSS("opacity", "1");

    const samples = await footer.evaluate((node) => {
      const footerNode = node as HTMLElement;
      return new Promise<Array<{ opacity: number; transform: string }>>((resolve) => {
        const values: Array<{ opacity: number; transform: string }> = [];
        const startedAt = performance.now();
        const sample = () => {
          const style = getComputedStyle(footerNode);
          values.push({
            opacity: Number.parseFloat(style.opacity),
            transform: style.transform,
          });
          if (performance.now() - startedAt < 800) {
            requestAnimationFrame(sample);
            return;
          }
          resolve(values);
        };
        requestAnimationFrame(sample);
      });
    });

    expect(samples.length).toBeGreaterThan(10);
    expect(samples.every((sample) => sample.opacity >= 0.999)).toBe(true);
    const identityTransform = "matrix(1, 0, 0, 1, 0, 0)";
    const movingTransforms = new Set(
      samples
        .map((sample) => sample.transform)
        .filter((transform) => transform !== "none" && transform !== identityTransform),
    );
    expect(movingTransforms.size).toBe(0);
  } finally {
    await agent.cleanup();
  }
});

test("animates later markdown blocks as they enter the chat viewport", async ({ page }) => {
  const agent = await startRunningMockAgent(page, {
    prefix: "assistant-block-entry-motion-",
    model: "e2e-fast-stream",
    prompt: "First message before measuring later markdown block motion.",
  });
  try {
    await awaitAssistantMessage(page);
    await expectAgentIdle(page);

    await page.evaluate(() => {
      interface Sample {
        opacity: number;
        transform: string;
      }
      const existing = new Set(document.querySelectorAll('[data-testid="assistant-message"] > *'));
      const tracked: Array<{ node: Element; samples: Sample[] }> = [];
      const startedAt = performance.now();
      const sample = () => {
        const blocks = Array.from(
          document.querySelectorAll('[data-testid="assistant-message"] > *'),
        );
        for (const node of blocks) {
          if (existing.has(node)) {
            continue;
          }
          let entry = tracked.find((candidate) => candidate.node === node);
          if (!entry) {
            entry = { node, samples: [] };
            tracked.push(entry);
          }
          const style = getComputedStyle(node);
          entry.samples.push({
            opacity: Number.parseFloat(style.opacity),
            transform: style.transform,
          });
        }
        if (performance.now() - startedAt < 2_400) {
          requestAnimationFrame(sample);
          return;
        }
        Reflect.set(
          globalThis,
          "__assistantBlockArrivalSamples",
          tracked.map((entry) => entry.samples),
        );
      };
      requestAnimationFrame(sample);
    });

    await submitMessage(page, "Measure later markdown blocks as they appear.");
    await awaitAssistantMessage(page);
    await page.waitForTimeout(2_500);

    const arrivals = await page.evaluate(
      () =>
        Reflect.get(globalThis, "__assistantBlockArrivalSamples") as Array<
          Array<{ opacity: number; transform: string }>
        >,
    );
    expect(arrivals.length).toBeGreaterThan(1);

    const laterArrivals = arrivals.slice(1);
    const arrivalSummary = arrivals.map((samples) => ({
      count: samples.length,
      opacities: [...new Set(samples.map((sample) => sample.opacity))],
      transforms: new Set(samples.map((sample) => sample.transform)).size,
    }));
    const animatedArrivals = laterArrivals.filter((samples) => {
      const moving = samples.filter((sample) => sample.opacity > 0 && sample.opacity < 0.999);
      return moving.length > 1 && new Set(moving.map((sample) => sample.transform)).size > 1;
    });
    expect(
      animatedArrivals.length,
      `expected later markdown blocks to animate in, received ${JSON.stringify(arrivalSummary)}`,
    ).toBeGreaterThan(0);
  } finally {
    await agent.cleanup();
  }
});

test("clips wrapped stream lines until they rise into the markdown block", async ({ page }) => {
  const agent = await startRunningMockAgent(page, {
    prefix: "assistant-block-growth-clip-",
    model: "e2e-fast-stream",
    prompt: "First message before measuring wrapped line growth.",
  });
  try {
    await awaitAssistantMessage(page);
    await expectAgentIdle(page);

    await page.evaluate(() => {
      const samples: Array<{ clipHeight: number; contentHeight: number }> = [];
      const startedAt = performance.now();
      const sample = () => {
        const clips = Array.from(
          document.querySelectorAll<HTMLElement>('[data-testid="assistant-block-growth-clip"]'),
        );
        const clip = clips.at(-1);
        const inner = clip?.firstElementChild;
        if (clip instanceof HTMLElement && inner instanceof HTMLElement) {
          samples.push({
            clipHeight: clip.getBoundingClientRect().height,
            contentHeight: inner.getBoundingClientRect().height,
          });
        }
        if (performance.now() - startedAt < 2_000) {
          requestAnimationFrame(sample);
          return;
        }
        Reflect.set(globalThis, "__assistantBlockGrowthClipSamples", samples);
      };
      requestAnimationFrame(sample);
    });

    await submitMessage(page, "Measure wrapped stream lines as they grow.");
    await awaitAssistantMessage(page);
    await page.waitForTimeout(2_100);

    const samples = await page.evaluate(
      () =>
        Reflect.get(globalThis, "__assistantBlockGrowthClipSamples") as Array<{
          clipHeight: number;
          contentHeight: number;
        }>,
    );
    const clippingSummary = {
      count: samples.length,
      clipping: samples.filter((sample) => sample.contentHeight - sample.clipHeight > 2).length,
      maxGap: Math.max(0, ...samples.map((sample) => sample.contentHeight - sample.clipHeight)),
    };
    expect(
      clippingSummary.clipping,
      `expected wrapped lines to stay clipped while the block height catches up, received ${JSON.stringify(clippingSummary)}`,
    ).toBeGreaterThan(2);
  } finally {
    await agent.cleanup();
  }
});
