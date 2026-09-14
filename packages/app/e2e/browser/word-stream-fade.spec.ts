import { test, expect } from "../support/fixtures";
import { startRunningMockAgent, cancelAgent } from "../support/helpers/composer";
import { awaitAssistantMessage } from "../support/helpers/agent-stream";
import { sampleWordFades, expectSettledSelectableText } from "../support/helpers/word-stream-fade";

test("released words fade left to right and settle into selectable text", async ({
  page,
}, testInfo) => {
  const agent = await startRunningMockAgent(page, {
    prefix: "word-fade-",
    model: "bursty-stream",
    prompt: "Stream bursty output for word fade verification.",
  });
  try {
    await awaitAssistantMessage(page);
    const report = await sampleWordFades(page);
    await testInfo.attach("word-fade-observations", {
      body: JSON.stringify(report),
      contentType: "application/json",
    });
    expect(report.directionalFades).toBeGreaterThan(10);
    expect(report.reverseFades).toBe(0);
    expect(report.boundaryReversals).toBe(0);
    expect(report.maxWidthDelta).toBeLessThan(0.5);
    expect(report.maxActiveLetters).toBeLessThan(500);
    await cancelAgent(page);
    await expectSettledSelectableText(page);
  } finally {
    await agent.cleanup();
  }
});
