import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, type TestInfo } from "@playwright/test";
import type { SeededWorkspace } from "./seed-client";
import { openAgentRoute } from "./mock-agent";
import { submitMessage } from "./composer";
import { selectModel } from "./app";
import { choosePermissionAction, waitForPermissionPrompt } from "./permissions";

export interface GrokControlsContext {
  page: Page;
  workspace: SeededWorkspace;
  testInfo: TestInfo;
  agentId: string;
  isolatedAgentId: string;
}

export async function createGrokAgent(workspace: SeededWorkspace, model: string) {
  return workspace.client.createAgent({
    provider: "grok",
    cwd: workspace.workspaceDirectory,
    workspaceId: workspace.workspaceId,
    title: `Grok ${model} controls`,
    model,
    thinkingOptionId: "low",
    modeId: "ask",
    featureValues: { auto_accept: true },
  });
}

async function expectControls(
  page: Page,
  { effort, mode }: { effort: string; mode: string },
): Promise<void> {
  await expect(
    page.getByRole("button", { name: `Select thinking option (${effort})` }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: `Select agent mode (${mode})` })).toBeVisible();
}

async function selectControl({
  page,
  control,
  label,
}: {
  page: Page;
  control: "thinking" | "mode";
  label: string;
}): Promise<void> {
  await page
    .getByRole("button", {
      name: control === "thinking" ? /^Select thinking option \(/ : /^Select agent mode \(/,
    })
    .click({ timeout: 10_000 });
  const popup = page.getByTestId("combobox-desktop-container").last();
  await expect(popup).toBeVisible();
  await popup.getByText(label, { exact: true }).click({ timeout: 10_000 });
  await expect(popup).not.toBeVisible();
}

export async function verifyGrokEffortSelection({
  page,
  workspace,
  agentId,
  testInfo,
}: GrokControlsContext): Promise<void> {
  await openAgentRoute(page, { workspaceId: workspace.workspaceId, agentId });
  await expectControls(page, { effort: "Low", mode: "Ask" });
  await selectControl({ page, control: "thinking", label: "Unavailable" });
  await expect(
    page.getByText("Grok cannot select effort 'unsupported'", { exact: true }),
  ).toBeVisible();
  await expectControls(page, { effort: "Low", mode: "Ask" });
  await selectControl({ page, control: "thinking", label: "Extra high" });
  await expectControls(page, { effort: "Extra high", mode: "Ask" });
  await selectModel(page, "Grok 4.5");
  await expectControls(page, { effort: "High", mode: "Ask" });
  await selectControl({ page, control: "thinking", label: "Low" });
  await expectControls(page, { effort: "Low", mode: "Ask" });
  await page.screenshot({ path: testInfo.outputPath("grok-effort-and-permissions.png") });
}

async function submitProof(page: Page, fileName: string): Promise<void> {
  await submitMessage(
    page,
    `Use your bash tool to run exactly: printf grok-controls-ok > ${fileName} . Do not include the trailing dot in the command. Then reply DONE. Do not use any other tools.`,
  );
}

async function waitForProof(
  { workspace, agentId }: GrokControlsContext,
  fileName: string,
): Promise<void> {
  await expect(async () => {
    expect(await readFile(join(workspace.workspaceDirectory, fileName), "utf8")).toBe(
      "grok-controls-ok",
    );
  }).toPass({ timeout: 120_000 });
  await workspace.client.waitForFinish(agentId, 120_000);
}

export async function approveGrokWrite(context: GrokControlsContext, name: string): Promise<void> {
  const { page, workspace, agentId, testInfo } = context;
  const fileName = `${name}-proof.txt`;
  await openAgentRoute(page, { workspaceId: workspace.workspaceId, agentId });
  await expectControls(page, { effort: "Low", mode: "Ask" });
  await submitProof(page, fileName);
  await waitForPermissionPrompt(page, 120_000);
  await page.screenshot({ path: testInfo.outputPath(`grok-${name}-approval.png`) });
  await choosePermissionAction(page, "Yes, proceed");
  await waitForProof(context, fileName);
}

export async function allowGrokWrite(
  context: GrokControlsContext,
  mode: "Always approve" | "Auto",
): Promise<void> {
  const { page, workspace, agentId, testInfo } = context;
  const name = mode === "Auto" ? "auto" : "approved";
  await openAgentRoute(page, { workspaceId: workspace.workspaceId, agentId });
  await selectControl({ page, control: "mode", label: mode });
  await expectControls(page, { effort: "Low", mode: mode === "Auto" ? "Auto" : "Always Approve" });
  await submitProof(page, `${name}-proof.txt`);
  await waitForProof(context, `${name}-proof.txt`);
  await expect(page.getByTestId("permission-request-question")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath(`grok-${name}.png`) });
}
