import type { Locator } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { gateSecondToolCall } from "../support/helpers/tool-call-gate";
import { expectComposerVisible } from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

interface ShimmerEvidence {
  animationDuration: string;
  endPx: number;
  label: string;
  renderedWidth: number;
  startPx: number;
}

async function readShimmerEvidence(locator: Locator): Promise<ShimmerEvidence> {
  return locator.evaluate((root) => {
    const shimmer = Array.from(root.querySelectorAll<HTMLElement>("*")).find((element) =>
      getComputedStyle(element).animationName.includes("paseo-toolcall-shimmer"),
    );
    if (!shimmer) {
      throw new Error("Expected a running shimmer inside the badge");
    }
    const style = getComputedStyle(shimmer);
    return {
      animationDuration: style.animationDuration,
      endPx: Number.parseFloat(style.getPropertyValue("--paseo-shimmer-end")),
      label: shimmer.textContent ?? "",
      renderedWidth: shimmer.getBoundingClientRect().width,
      startPx: Number.parseFloat(style.getPropertyValue("--paseo-shimmer-start")),
    };
  });
}

test("measures an overview heading that becomes loading after its idle mount", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    localStorage.setItem(
      "@paseo:app-settings",
      JSON.stringify({ chatDisplay: "collapseToolCalls" }),
    );
  });
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "tool-call-shimmer-",
    title: "Tool-call shimmer",
    model: "ten-second-stream",
  });

  try {
    const gate = await gateSecondToolCall(page, agent.agentId);
    await openAgentRoute(page, {
      workspaceId: agent.workspaceId,
      agentId: agent.agentId,
    });
    await expectComposerVisible(page);
    await agent.client.sendAgentMessage(agent.agentId, "Prove the overview shimmer lifecycle.");

    await gate.waitForFirstCompleted();
    const group = page.getByTestId("tool-call-group").first();
    await expect(group).toBeVisible();
    const idleGroupHandle = await group.elementHandle();
    if (!idleGroupHandle) {
      throw new Error("Expected the idle tool-call group to be mounted");
    }
    await expect(group.locator('[style*="paseo-toolcall-shimmer"]')).toHaveCount(0);

    await gate.waitForSecondRunning();
    gate.releaseSecondRunning();
    await expect(group.locator('[style*="paseo-toolcall-shimmer"]')).not.toHaveCount(0);
    const sameGroupNode = await group.evaluate(
      (node, previous) => node === previous,
      idleGroupHandle,
    );

    await group.click();
    const runningChild = page.getByTestId("tool-call-badge").last();
    await expect(runningChild).toBeVisible();
    const header = await readShimmerEvidence(group);
    const child = await readShimmerEvidence(runningChild);
    const evidence = { sameGroupNode, header, child };
    await testInfo.attach("tool-call-shimmer-evidence", {
      body: JSON.stringify(evidence, null, 2),
      contentType: "application/json",
    });

    expect(sameGroupNode).toBe(true);
    expect(child.endPx).toBeGreaterThan(0);
    expect(
      header.endPx,
      `The retained header rendered ${header.renderedWidth}px wide but its shimmer still ends at ${header.endPx}px`,
    ).toBeGreaterThan(0);
  } finally {
    await agent.cleanup();
  }
});
