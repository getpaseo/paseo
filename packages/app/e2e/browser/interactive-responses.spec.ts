import { scrollTimelineToOldestLoadedEdge } from "../support/helpers/timeline-pagination";
import { gateNextAgentMessage } from "../support/helpers/agent-message-gate";
import { extractInteractiveDocumentId } from "@getpaseo/protocol/interactive-response-reference";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { expect, test as base } from "../support/fixtures";
import { seedMockAgentWorkspace, openAgentRoute } from "../support/helpers/mock-agent";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";

const test = base.extend({
  e2eInjectPaseoTools: [true, { scope: "worker" }],
  e2eDaemonEnvironment: [{ PASEO_EXPERIMENTAL_INTERACTIVE_RESPONSES: "1" }, { scope: "worker" }],
});
const input = {
  title: "Choose your plan",
  summary: "Compare the plans and send your choice.",
  source:
    'root = Layout([Text("A plan for this project"), Comparison(["Plan", "Price"], [["Basic", "10"], ["Pro", "20"]]), Selection("plan", "Your plan", ["Basic", "Pro"]), Input("notes", "Notes"), BarChart([{label:"Basic",value:10},{label:"Pro",value:20}], "Monthly price")])',
};
test("interactive responses persist selections and send snapshots before deepening a historical answer", async ({
  page,
}, info) => {
  const session = await seedMockAgentWorkspace({
    repoPrefix: "interactive-",
    title: "Interactive responses",
    initialPrompt: `Render synthetic interactive response: ${JSON.stringify(input)}`,
    featureValues: { mockAssistantResponse: "The chosen plan is recorded." },
  });
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "interactive-check" });
  try {
    await client.waitForFinish(session.agentId, 15000);
    const generated = await client.fetchAgentTimeline(session.agentId, { limit: 200 });
    await info.attach("generated-timeline", {
      body: JSON.stringify(generated, null, 2),
      contentType: "application/json",
    });
    expect(JSON.stringify(generated)).toContain("documentId");
    await page.setViewportSize({ width: 1200, height: 1400 });
    const gate = await gateNextAgentMessage(page);
    await openAgentRoute(page, session);
    const card = page.getByTestId("interactive-response");
    await expect(card).toContainText(input.title);
    const tool = generated.entries.find((entry) => entry.item.type === "tool_call");
    const documentId =
      tool?.item.type === "tool_call" && tool.item.detail.type === "unknown"
        ? extractInteractiveDocumentId(tool.item.detail.output)
        : null;
    expect(documentId).not.toBeNull();
    await client.updateInteractiveResponse(session.agentId, documentId!, 0, { plan: "Basic" });
    await card.getByRole("button", { name: "Pro", exact: true }).click();
    await expect(card.getByRole("alert")).toContainText("revision conflict");
    await scrollTimelineToOldestLoadedEdge(page);
    await card.screenshot({ path: info.outputPath("interactive-conflict.png") });
    await card.getByRole("button", { name: "Reload", exact: true }).click();
    await card.getByRole("button", { name: "Pro", exact: true }).click();
    await card.getByRole("textbox", { name: "Notes" }).fill("For the team");
    await card.getByRole("button", { name: "Expand", exact: true }).click();
    await expect(page.getByText("Monthly price", { exact: true })).toBeVisible();
    await page.screenshot({
      path: info.outputPath("interactive-expanded.png"),
      animations: "disabled",
    });
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    await card.getByRole("button", { name: "Send to agent", exact: true }).click();
    await gate.waitForRequest();
    await expect(card.getByRole("button", { name: "Sent", exact: true })).toHaveCount(0);
    gate.accept();
    await expect(card.getByRole("button", { name: "Sent", exact: true })).toBeVisible();
    await scrollTimelineToOldestLoadedEdge(page);
    await card.screenshot({
      path: info.outputPath("interactive-desktop.png"),
      animations: "disabled",
    });
    await page.reload();
    await expect(card).toContainText(input.title);
    await expect(card.getByRole("textbox", { name: "Notes" })).toHaveValue("For the team");
    await page.getByRole("button", { name: "Explore further", exact: true }).first().click();
    await gate.waitForRequest(2);
    gate.accept(1);
    await expect(page.getByText("Explore this response:", { exact: false }).first()).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await scrollTimelineToOldestLoadedEdge(page);
    await expect(card).toBeVisible();
    await page.setViewportSize({ width: 390, height: 1400 });
    await scrollTimelineToOldestLoadedEdge(page);
    await card.screenshot({ path: info.outputPath("interactive-mobile-web.png") });
    const timeline = await client.fetchAgentTimeline(session.agentId, { limit: 200 });
    expect(JSON.stringify(timeline)).toContain("Selection received:");
    expect(JSON.stringify(timeline)).toContain("For the team");
    expect(timeline.agent?.model).toBe("e2e-fast-stream");
    await page.evaluate(() => {
      const settings = JSON.parse(localStorage.getItem("@paseo:app-settings") ?? "{}");
      localStorage.setItem(
        "@paseo:app-settings",
        JSON.stringify({ ...settings, theme: "pureBlack" }),
      );
    });
    await page.setViewportSize({ width: 1200, height: 1400 });
    await page.reload();
    await scrollTimelineToOldestLoadedEdge(page);
    await expect(card).toBeVisible();
    await card.screenshot({ path: info.outputPath("interactive-dark.png") });
  } catch (error) {
    await page.screenshot({ path: info.outputPath("interactive-failure.png") });
    throw error;
  } finally {
    await client.close();
    await session.cleanup();
  }
});

test("HTML previews block generated scripts, network access and forged bridge messages", async ({
  page,
}, info) => {
  const html =
    '<div id="visual">Offline preview</div><img src="https://example.com/paseo-artifact-exfil"><script>document.getElementById("visual").textContent="Unsafe execution";fetch("https://example.com/paseo-artifact-exfil");parent.postMessage({type:"send",text:"forged"},"*")</script>';
  const source = `root = Layout([HtmlArtifact(${JSON.stringify(html)})])`;
  const session = await seedMockAgentWorkspace({
    repoPrefix: "interactive-html-",
    title: "Offline visual",
    initialPrompt: `Render synthetic interactive response: ${JSON.stringify({ title: "Offline visual", summary: "A self-contained preview", source })}`,
  });
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("paseo-artifact-exfil")) requests.push(request.url());
  });
  try {
    await page.setViewportSize({ width: 1200, height: 1400 });
    await openAgentRoute(page, session);
    await expect(page.getByTestId("interactive-response")).toContainText("Offline visual");
    await expect(page.getByTestId("interactive-response").getByRole("alert")).toContainText(
      "Execution is blocked",
    );
    await expect(
      page
        .frameLocator('iframe[title="HTML visual"]')
        .getByText("Offline preview", { exact: true }),
    ).toBeVisible();
    await page.evaluate(() =>
      window.postMessage({ type: "send", text: "forged", state: { plan: "forged" } }, "*"),
    );
    await expect(page.getByText("forged", { exact: true })).toHaveCount(0);
    expect(requests).toEqual([]);
    await scrollTimelineToOldestLoadedEdge(page);
    await page
      .getByTestId("interactive-response")
      .screenshot({ path: info.outputPath("interactive-html-inert.png") });
  } catch (error) {
    await page.screenshot({ path: info.outputPath("html-failure.png") });
    throw error;
  } finally {
    await session.cleanup();
  }
});

base("keeps unfinished interactive actions hidden and rejects their RPCs", async ({ page }) => {
  const session = await seedMockAgentWorkspace({
    repoPrefix: "interactive-disabled-",
    title: "Ordinary conversation",
    initialPrompt: "Hello",
    featureValues: { mockAssistantResponse: "A normal answer." },
  });
  const client = await connectDaemonClient<DaemonClient>({
    clientIdPrefix: "interactive-disabled",
  });
  try {
    await client.waitForFinish(session.agentId, 15000);
    expect(client.getLastServerInfoMessage()?.features?.interactiveResponses).toBe(false);
    const documentId = "a4965c0c-63e2-4b95-8c4f-574482312432";
    expect((await client.getInteractiveResponse(session.agentId, documentId)).error).toContain(
      "disabled",
    );
    expect(
      (await client.updateInteractiveResponse(session.agentId, documentId, 0, {})).error,
    ).toContain("disabled");
    await expect(
      client.sendAgentMessage(session.agentId, "Selection", {
        interactiveReference: { documentId, revision: 0 },
      }),
    ).rejects.toThrow("disabled");
    await expect(
      client.sendAgentMessage(session.agentId, "Explain", {
        deepenReference: { messageId: "unavailable" },
      }),
    ).rejects.toThrow("disabled");
    await openAgentRoute(page, session);
    await expect(page.getByText("A normal answer.", { exact: false }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Explore further", exact: true })).toHaveCount(0);
  } finally {
    await client.close();
    await session.cleanup();
  }
});
