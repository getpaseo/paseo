import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { expect, test } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";

test("creates a durable assistant from a template and keeps its independent context after reload", async ({
  page,
}, testInfo) => {
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "assistant-browser" });
  const template = await client.saveAssistantTemplate({
    name: "Chief of staff",
    configuration: {
      instructions: "",
      voice: null,
      backendModel: null,
      backendThinkingOptionId: null,
      context: "The project is Iris.",
    },
  });
  let assistantId: string | undefined;
  try {
    await gotoAppShell(page);
    await openSettings(page);
    await page
      .getByTestId("settings-sidebar")
      .getByRole("button", { name: "Live voice", exact: true })
      .click();
    await page.getByTestId("settings-manage-assistants").click();
    await page.getByTestId("assistants-sheet-new-assistant").click();
    await page.getByTestId("assistant-form-name").fill("Work assistant");
    await page.getByTestId("assistant-form-template").click();
    await page.getByText("Chief of staff", { exact: true }).click();
    await expect(page.getByTestId("assistant-form-context")).toHaveValue("The project is Iris.");
    await page.screenshot({
      path: testInfo.outputPath("assistant-template-form.png"),
      fullPage: true,
    });
    await page.getByTestId("assistant-form-submit").click();
    await expect(page.getByText("Work assistant", { exact: true })).toBeVisible();
    const assistant = (await client.listAssistants()).find(
      (entry) => entry.name === "Work assistant",
    );
    expect(assistant).toBeDefined();
    assistantId = assistant!.id;
    expect(assistant!.templateId).toBe(template.id);
    await client.saveAssistantTemplate({
      templateId: template.id,
      expectedRevision: template.revision,
      name: template.name,
      configuration: { ...template.configuration, context: "Changed template" },
    });
    await page.reload();
    await page.getByTestId("settings-manage-assistants").click();
    await expect(page.getByTestId(`assistant-row-${assistantId}`)).toBeVisible();
    expect((await client.getAssistant({ assistantId })).assistant.configuration.context).toBe(
      "The project is Iris.",
    );
    await page.screenshot({ path: testInfo.outputPath("assistant-restored.png"), fullPage: true });
  } finally {
    if (assistantId) await client.deleteAssistant({ assistantId });
    await client.deleteAssistantTemplate({ templateId: template.id });
    await client.close();
  }
});
