import { expect, test } from "../support/fixtures";
import { openAgentRoute } from "../support/helpers/mock-agent";
import { seedWorkspace } from "../support/helpers/seed-client";

test.use({
  e2eDaemonConfig: { version: 1, agents: { providers: { omp: { enabled: true } } } },
});

const html = `<form>
  <p>Choose the storage for this test.</p>
  <fieldset><legend>Storage</legend>
    <label><input type="radio" name="store" value="sqlite" checked>SQLite</label>
    <label><input type="radio" name="store" value="memory">In memory</label>
  </fieldset>
  <label>Days <input type="number" name="days" min="1" required></label>
  <label>Note <input name="note" required></label>
</form>`;

test("answers an HTML form from the real OMP provider", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const workspace = await seedWorkspace({ repoPrefix: "omp-form-", git: false });
  try {
    const agent = await workspace.client.createAgent({
      cwd: workspace.workspaceDirectory,
      workspaceId: workspace.workspaceId,
      provider: "omp",
      model: process.env.E2E_OMP_FORM_MODEL,
      modeId: "full",
      title: "OMP form smoke test",
    });
    await openAgentRoute(page, { workspaceId: workspace.workspaceId, agentId: agent.id });
    await workspace.client.sendAgentMessage(
      agent.id,
      `Call the ask tool exactly once with this exact HTML string. Do not call other tools. After the user submits, reply with the exact value of the note field.\n${html}`,
    );

    const form = page.frameLocator('iframe[title="OMP ask"]');
    await expect(form.getByRole("radio", { name: "SQLite" })).toBeChecked({ timeout: 90_000 });
    await expect(form.getByText("Choose the storage for this test.")).toBeVisible();
    await form.getByRole("radio", { name: "In memory" }).check();
    await form.getByRole("spinbutton", { name: "Days" }).fill("7");
    await form.getByRole("textbox", { name: "Note" }).fill("FORM_ANSWER_51J7");
    await page.screenshot({ path: testInfo.outputPath("omp-form-filled.png") });
    await form.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(page.locator('iframe[title="OMP ask"]')).toHaveCount(0);
    await expect(page.getByText("FORM_ANSWER_51J7", { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await page.screenshot({ path: testInfo.outputPath("omp-form-answered.png") });
  } finally {
    await workspace.cleanup();
  }
});
