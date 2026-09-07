import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import { seedWorkspace } from "../support/helpers/seed-client";
import { openAgentRoute } from "../support/helpers/mock-agent";
import { submitMessage } from "../support/helpers/composer";
import { selectModel } from "../support/helpers/app";
import { choosePermissionAction, waitForPermissionPrompt } from "../support/helpers/permissions";

test.use({
  e2eDaemonConfig: {
    version: 1,
    agents: {
      providers: {
        grok: {
          extends: "acp",
          label: "Grok",
          command: ["grok", "--no-auto-update", "agent", "stdio"],
          enabled: true,
          // A stale configured choice exercises a real daemon rejection from the picker.
          additionalModels: [
            {
              id: "grok-4.6",
              label: "Grok 4.6",
              thinkingOptions: [
                { id: "xhigh", label: "Extra high" },
                { id: "high", label: "High", isDefault: true },
                { id: "medium", label: "Medium" },
                { id: "low", label: "Low" },
                { id: "unsupported", label: "Unavailable" },
              ],
            },
          ],
        },
      },
    },
  },
});

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

test("Grok composer controls apply effort and native tool permissions", async ({
  page,
}, testInfo) => {
  test.setTimeout(360_000);
  const workspace = await seedWorkspace({ repoPrefix: "grok-controls-" });
  const agentIds: string[] = [];
  const submitProof = async (fileName: string) => {
    await submitMessage(
      page,
      `Use your bash tool to run exactly: printf grok-controls-ok > ${fileName} . Do not include the trailing dot in the command. Then reply DONE. Do not use any other tools.`,
    );
  };
  const waitForProof = async ({ agentId, fileName }: { agentId: string; fileName: string }) => {
    await expect(async () => {
      expect(await readFile(join(workspace.workspaceDirectory, fileName), "utf8")).toBe(
        "grok-controls-ok",
      );
    }).toPass({ timeout: 120_000 });
    await workspace.client.waitForFinish(agentId, 120_000);
  };
  try {
    const agent = await workspace.client.createAgent({
      provider: "grok",
      cwd: workspace.workspaceDirectory,
      workspaceId: workspace.workspaceId,
      title: "Grok controls",
      model: "grok-4.6",
      thinkingOptionId: "low",
      modeId: "ask",
      featureValues: { auto_accept: true },
    });
    agentIds.push(agent.id);
    await openAgentRoute(page, { workspaceId: workspace.workspaceId, agentId: agent.id });
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

    await submitProof("ask-proof.txt");
    await waitForPermissionPrompt(page, 120_000);
    await page.screenshot({ path: testInfo.outputPath("grok-ask-approval.png") });
    await choosePermissionAction(page, "Yes, proceed");
    await waitForProof({ agentId: agent.id, fileName: "ask-proof.txt" });

    const isolatedAgent = await workspace.client.createAgent({
      provider: "grok",
      cwd: workspace.workspaceDirectory,
      workspaceId: workspace.workspaceId,
      title: "Grok isolated Ask",
      model: "grok-4.5",
      thinkingOptionId: "low",
      modeId: "ask",
    });
    agentIds.push(isolatedAgent.id);

    await selectControl({ page, control: "mode", label: "Always approve" });
    await expectControls(page, { effort: "Low", mode: "Always Approve" });
    await page.screenshot({ path: testInfo.outputPath("grok-always-approve.png") });
    await submitProof("approved-proof.txt");
    await waitForProof({ agentId: agent.id, fileName: "approved-proof.txt" });
    await expect(page.getByTestId("permission-request-question")).toHaveCount(0);
    await openAgentRoute(page, {
      workspaceId: workspace.workspaceId,
      agentId: isolatedAgent.id,
    });
    await expectControls(page, { effort: "Low", mode: "Ask" });
    await submitProof("isolated-proof.txt");
    await waitForPermissionPrompt(page, 120_000);
    await page.screenshot({ path: testInfo.outputPath("grok-isolated-ask.png") });
    await choosePermissionAction(page, "Yes, proceed");
    await waitForProof({ agentId: isolatedAgent.id, fileName: "isolated-proof.txt" });
    await openAgentRoute(page, { workspaceId: workspace.workspaceId, agentId: agent.id });
    await selectControl({ page, control: "mode", label: "Auto" });
    await expectControls(page, { effort: "Low", mode: "Auto" });
    await submitProof("auto-proof.txt");
    await waitForProof({ agentId: agent.id, fileName: "auto-proof.txt" });
    await expect(page.getByTestId("permission-request-question")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("grok-auto-approved.png") });
  } catch (error) {
    await page.screenshot({ path: testInfo.outputPath("grok-controls-error.png") });
    throw error;
  } finally {
    for (const agentId of agentIds) await workspace.client.archiveAgent(agentId);
    await workspace.cleanup();
  }
});
