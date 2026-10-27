import { scrollTimelineToOldestLoadedEdge } from "../support/helpers/timeline-pagination";
import { gateNextAgentMessage } from "../support/helpers/agent-message-gate";
import { extractInteractiveDocumentId } from "@getpaseo/protocol/interactive-response-reference";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { expect, test as base } from "../support/fixtures";
import { seedMockAgentWorkspace, openAgentRoute } from "../support/helpers/mock-agent";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";

const test = base.extend({
  e2eInjectPaseoTools: [true, { scope: "worker" }],
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

test("custom JavaScript restores state, filters dynamic markup and sends only after confirmation", async ({
  page,
}, info) => {
  const script = `let count=paseo.getState()?.count??2;
function draw(){paseo.render('<style>button{padding:12px;border-radius:8px}</style><h2>Project calculator</h2><button id="add">Add: '+count+'</button><input id="amount" type="range" min="0" max="10" value="'+count+'"><textarea id="note" aria-label="Note"></textarea><img src="https://example.com/paseo-artifact-exfil"><div onclick="parent.postMessage(1)" id="dynamic">Offline</div>')}
function save(){paseo.setState({count});paseo.propose('Choose '+count);draw()}
draw();paseo.on('add','click',()=>{count++;save()});paseo.on('amount','input',event=>{count=Number(event.value);save()});paseo.on('note','input',event=>paseo.propose(event.value));
if([typeof fetch,typeof parent,typeof document,typeof WebSocket,typeof process].some(value=>value!=='undefined')) throw Error('Host access');`;
  const html = "<script>" + script + "</script>";
  const source = `root = Layout([HtmlArtifact(${JSON.stringify(html)})])`;
  const session = await seedMockAgentWorkspace({
    repoPrefix: "interactive-script-",
    title: "Custom visual",
    initialPrompt: `Render synthetic interactive response: ${JSON.stringify({ title: "Project calculator", summary: "Adjust and confirm", source })}`,
    featureValues: { mockAssistantResponse: "Choice received." },
  });
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "interactive-script" });
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("paseo-artifact-exfil")) requests.push(request.url());
  });
  try {
    await page.setViewportSize({ width: 1200, height: 1100 });
    await openAgentRoute(page, session);
    const card = page.getByTestId("interactive-response");
    const visual = page.frameLocator('iframe[title="HTML visual"]');
    await visual.getByRole("button", { name: "Add: 2", exact: true }).click();
    await expect(visual.getByRole("button", { name: "Add: 3", exact: true })).toBeVisible();
    await expect(card.getByText("Choose 3", { exact: true })).toBeVisible();
    await visual.getByRole("textbox", { name: "Note" }).fill("A multiline note");
    await expect(card.getByText("A multiline note", { exact: true })).toBeVisible();
    await visual.getByRole("slider").focus();
    await visual.getByRole("slider").press("ArrowRight");
    await expect(visual.getByRole("button", { name: "Add: 4", exact: true })).toBeVisible();
    await expect(visual.getByRole("slider")).toBeFocused();
    await visual.getByRole("slider").press("ArrowLeft");
    await expect(visual.getByRole("button", { name: "Add: 3", exact: true })).toBeVisible();
    const slider = visual.getByRole("slider");
    const bounds = await slider.boundingBox();
    if (!bounds) throw new Error("Missing slider bounds");
    const y = bounds.y + bounds.height / 2;
    await page.mouse.move(bounds.x + 8 + (bounds.width - 16) * 0.3, y);
    await page.mouse.down();
    await page.mouse.move(bounds.x + 8 + (bounds.width - 16) * 0.5, y);
    await expect(visual.getByRole("button", { name: "Add: 5", exact: true })).toBeVisible();
    await page.mouse.move(bounds.x + 8 + (bounds.width - 16) * 0.9, y);
    await page.mouse.up();
    await expect(visual.getByRole("button", { name: "Add: 9", exact: true })).toBeVisible();
    await slider.press("Home");
    await expect(visual.getByRole("button", { name: "Add: 0", exact: true })).toBeVisible();
    for (const value of [1, 2, 3]) {
      await slider.press("ArrowRight");
      await expect(
        visual.getByRole("button", { name: `Add: ${value}`, exact: true }),
      ).toBeVisible();
    }
    await expect(page.getByText("Selection received:", { exact: false })).toHaveCount(0);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(page.locator('iframe[title="HTML visual"]')).toHaveCount(0);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "visible",
      });
      Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(visual.getByRole("button", { name: "Add: 3", exact: true })).toBeVisible();
    await page.reload();
    await expect(visual.getByRole("button", { name: "Add: 3", exact: true })).toBeVisible();
    await expect(card.getByText("Choose 3", { exact: true })).toBeVisible();
    await page.evaluate(() => window.postMessage({ type: "state", value: "forged" }, "*"));
    await expect(card).not.toContainText("forged");
    await card.getByRole("button", { name: "Expand", exact: true }).click();
    await expect(visual.getByRole("button", { name: "Add: 3", exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("interactive-script-expanded.png") });
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    await expect(visual.getByRole("button", { name: "Add: 3", exact: true })).toBeVisible();
    await card.getByRole("button", { name: "Send to agent", exact: true }).click();
    await expect(card.getByRole("button", { name: "Sent", exact: true })).toBeVisible();
    const timeline = await client.fetchAgentTimeline(session.agentId, { limit: 200 });
    expect(JSON.stringify(timeline)).toContain("Choose 3");
    expect(requests).toEqual([]);
    await scrollTimelineToOldestLoadedEdge(page);
    await card.screenshot({ path: info.outputPath("interactive-script-desktop.png") });
    await page.setViewportSize({ width: 390, height: 1000 });
    await scrollTimelineToOldestLoadedEdge(page);
    await card.screenshot({ path: info.outputPath("interactive-script-compact.png") });
  } finally {
    await client.close();
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

test("a failed custom visual can be retried without losing its saved state", async ({ page }) => {
  const html =
    '<script>if(!paseo.getState()?.recovered){paseo.setState({recovered:true});while(true){}}else{paseo.render("<h2>Recovered</h2>")}</script>';
  const source = `root = Layout([HtmlArtifact(${JSON.stringify(html)})])`;
  const session = await seedMockAgentWorkspace({
    repoPrefix: "interactive-retry-",
    title: "Visual retry",
    initialPrompt: `Render synthetic interactive response: ${JSON.stringify({ title: "Visual retry", summary: "Retry the visual", source })}`,
  });
  try {
    await openAgentRoute(page, session);
    const card = page.getByTestId("interactive-response");
    await expect(card.getByRole("alert")).toBeVisible();
    await card.getByRole("button", { name: "Reload", exact: true }).click();
    await expect(
      page
        .frameLocator('iframe[title="HTML visual"]')
        .getByRole("heading", { name: "Recovered", exact: true }),
    ).toBeVisible();
    await expect(card.getByRole("alert")).toHaveCount(0);
  } finally {
    await session.cleanup();
  }
});
