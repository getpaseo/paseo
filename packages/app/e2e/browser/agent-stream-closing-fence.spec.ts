import {
  beginTextReveal,
  retargetTextReveal,
  visibleRevealedText,
} from "../../src/agent-stream/text-reveal";
import type { Page } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { expectComposerVisible } from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

interface ClosingFenceFrameSample {
  text: string;
  codeBlockHeights: number[];
  codeBlockTexts: string[];
  messageHeights: number[];
  partialFenceLines: string[];
}

interface ClosingFenceFrameReport {
  finished: boolean;
  samples: ClosingFenceFrameSample[];
}

async function sampleClosingFenceFrames(page: Page): Promise<ClosingFenceFrameReport> {
  return await page.evaluate(async () => {
    const samples: ClosingFenceFrameSample[] = [];
    let finished = false;

    await new Promise<void>((resolve) => {
      const tick = () => {
        const messages = Array.from(
          document.querySelectorAll<HTMLElement>('[data-testid="assistant-message"]'),
        );
        const text = messages.map((message) => message.textContent ?? "").join("");
        const sample: ClosingFenceFrameSample = {
          text,
          codeBlockHeights: [],
          codeBlockTexts: [],
          messageHeights: messages.map((message) =>
            Math.round(message.getBoundingClientRect().height),
          ),
          partialFenceLines: [],
        };

        for (const message of messages) {
          for (const block of message.querySelectorAll<HTMLElement>(
            'pre, [data-paseo-markdown-tag="pre"]',
          )) {
            const code = block.querySelector<HTMLElement>('code, [data-paseo-markdown-tag="code"]');
            const codeText = code?.textContent ?? block.textContent ?? "";
            sample.codeBlockTexts.push(codeText.trimEnd());
            // Opening fence prefixes render as prose; closing artifacts live inside code blocks.
            for (const line of codeText.split(/\r?\n/)) {
              if (/^\s*`{1,2}\s*$/.test(line)) sample.partialFenceLines.push(line);
            }
            sample.codeBlockHeights.push(Math.round(block.getBoundingClientRect().height));
          }
        }

        samples.push(sample);

        finished = text.includes("Both blocks are closed.");
        if (finished) {
          resolve();
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    return { finished, samples };
  });
}

const FIRST_PAUSE_TEXT = "Here is the first snippet:const answer = 42;\nconsole.log(answer);";
const SECOND_PAUSE_TEXT = `${FIRST_PAUSE_TEXT}And a second one:echo done`;

for (const { label, html } of [
  { label: "semantic", html: "<pre><code>const answer = 42;\n`\n``</code></pre>" },
  {
    label: "annotated",
    html: '<div data-paseo-markdown-tag="pre"><span data-paseo-markdown-tag="code">const answer = 42;\n`\n``</span><button>Copy</button></div>',
  },
  {
    label: "annotated semantic",
    html: '<pre data-paseo-markdown-tag="pre"><code data-paseo-markdown-tag="code">const answer = 42;\n`\n``</code></pre>',
  },
]) {
  test(`samples ${label} code block DOM without duplicate blocks or controls`, async ({ page }) => {
    await page.setContent(
      `<div data-testid="assistant-message">${html}<p>Both blocks are closed.</p></div>`,
    );
    const report = await sampleClosingFenceFrames(page);
    const sample = report.samples.at(-1)!;
    expect(report.finished).toBe(true);
    expect(sample.codeBlockTexts).toEqual(["const answer = 42;\n`\n``"]);
    expect(sample.partialFenceLines).toEqual(["`", "``"]);
    expect(sample.codeBlockHeights).toHaveLength(1);
    expect(sample.codeBlockHeights[0]).toBeGreaterThan(0);
  });
}

function closingFencePauseSamples(
  samples: readonly ClosingFenceFrameSample[],
  pauseText: string,
): ClosingFenceFrameSample[] {
  return samples.filter((sample) => sample.text === pauseText);
}

function expectStableGeometry(
  samples: readonly ClosingFenceFrameSample[],
  expectedCodeBlockTexts: readonly string[],
): void {
  expect(samples.length, "the paused text state should be sampled").toBeGreaterThan(0);
  expect(
    samples.every(
      (sample) => JSON.stringify(sample.codeBlockTexts) === JSON.stringify(expectedCodeBlockTexts),
    ),
    "the sampled code should contain only the authored lines",
  ).toBe(true);
  const geometries = new Set(
    samples.map((sample) => JSON.stringify([sample.messageHeights, sample.codeBlockHeights])),
  );
  expect(
    geometries.size,
    "message and code block geometry should stay fixed during the pause",
  ).toBe(1);
}

/**
 * A closing fence that is still being typed must not be painted as code.
 *
 * The mock reply closes each code block in two arrivals: one backtick, a pause,
 * then the other two. Painted, that first backtick is a line of code that
 * vanishes when the fence completes, so the block grows and shrinks and every
 * row below it moves twice. Each pause is sampled and its text geometry checked.
 */
test("does not paint a closing fence while it is still being typed", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "closing-fence-",
    title: "Closing fence",
    model: "e2e-fast-stream",
  });
  try {
    await openAgentRoute(page, agent);
    await expectComposerVisible(page);
    const reportPromise = sampleClosingFenceFrames(page);
    await agent.client.sendAgentMessage(
      agent.agentId,
      "Stream a code block with a split closing fence.",
    );
    const report = await reportPromise;

    await testInfo.attach("closing-fence-frames", {
      body: JSON.stringify(report, null, 2),
      contentType: "application/json",
    });
    expect(report.finished, "the reply should finish streaming").toBe(true);
    expect(
      report.samples.flatMap((sample) => sample.partialFenceLines),
      "no frame, including transitions outside the pause windows, may show a partial fence inside code",
    ).toEqual([]);
    const firstPauseSamples = closingFencePauseSamples(report.samples, FIRST_PAUSE_TEXT);
    const secondPauseSamples = closingFencePauseSamples(report.samples, SECOND_PAUSE_TEXT);
    expectStableGeometry(firstPauseSamples, ["const answer = 42;\nconsole.log(answer);"]);
    expectStableGeometry(secondPauseSamples, [
      "const answer = 42;\nconsole.log(answer);",
      "echo done",
    ]);
    expect(secondPauseSamples[0]?.codeBlockHeights[0]).toBe(
      firstPauseSamples[0]?.codeBlockHeights[0],
    );
  } finally {
    await agent.cleanup();
  }
});

test("excludes each revealed character of the next paragraph from both pauses", () => {
  for (const [pauseText, paragraph] of [
    [FIRST_PAUSE_TEXT, "And a second one:"],
    [SECOND_PAUSE_TEXT, "Both blocks are closed."],
  ]) {
    const state = retargetTextReveal(beginTextReveal(pauseText), pauseText + paragraph);
    const samples = Array.from({ length: paragraph.length + 1 }, (_, index) => ({
      text: visibleRevealedText({ ...state, revealed: pauseText.length + index }),
      codeBlockHeights: [],
      codeBlockTexts: [],
      messageHeights: [index],
      partialFenceLines: [],
    }));
    expect(closingFencePauseSamples(samples, pauseText)).toEqual([samples[0]]);
  }
});

for (const { label, markdown, expectedCode, expectedPartialFenceLines } of [
  {
    label: "opening prefixes in prose",
    markdown: "And a second one:\n\n`\n\n``\n\nBoth blocks are closed.",
    expectedCode: [],
    expectedPartialFenceLines: [],
  },
  {
    label: "partial fences inside rendered code",
    markdown: "```ts\nconst answer = 42;\n`\n``\n```\n\nBoth blocks are closed.",
    expectedCode: ["const answer = 42;\n`\n``"],
    expectedPartialFenceLines: ["`", "``"],
  },
]) {
  test(`samples ${label} in the correct container`, async ({ page }, testInfo) => {
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "fence-sample-container-",
      title: "Fence sample container",
      featureValues: { mockAssistantResponse: markdown },
    });
    try {
      await openAgentRoute(page, agent);
      await expectComposerVisible(page);
      const reportPromise = sampleClosingFenceFrames(page);
      await agent.client.sendAgentMessage(agent.agentId, "Show the fence sampling fixture.");
      const report = await reportPromise;
      await testInfo.attach("fence-container-frames", {
        body: JSON.stringify(report, null, 2),
        contentType: "application/json",
      });
      expect(report.finished).toBe(true);
      const messageText = await page.getByTestId("assistant-message").innerText();
      const messageLines = messageText.split(/\r?\n/);
      const messageFenceLines = messageLines.filter((line) => /^\s*`{1,2}\s*$/.test(line));
      expect(messageFenceLines).toEqual(["`", "``"]);
      const finalSample = report.samples.at(-1);
      expect(finalSample?.codeBlockTexts).toEqual(expectedCode);
      expect(finalSample?.partialFenceLines).toEqual(expectedPartialFenceLines);
    } finally {
      await agent.cleanup();
    }
  });
}
