import { expect, test } from "../support/fixtures";
import { openCustomModels, removeCustomModel } from "../support/helpers/custom-models";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";

// A pressed control shows its own progress while the daemon answers, the way Button's `loading`
// does: a spinner in place of its icon, no further presses and, on a labelled button, a
// present-participle label.

const MODEL_ID = "in-flight-model";

test.describe("provider page work in flight", () => {
  test("says Adding... on the Add button while a custom model is saved", async ({ page }) => {
    const gate = await installDaemonWebSocketGate(page);
    await openCustomModels(page);

    await page.getByRole("button", { name: "Add model", exact: true }).click();
    const sheet = page.getByTestId("add-custom-model-sheet");
    await page.getByPlaceholder("e.g. openai/gpt-5").fill(MODEL_ID);
    gate.holdNextServerMessage("set_daemon_config_response");
    await sheet.getByRole("button", { name: "Add", exact: true }).click();
    await gate.waitForHeldServerMessage("set_daemon_config_response");

    const adding = sheet.getByRole("button", { name: "Adding...", exact: true });
    await expect(adding.getByRole("progressbar")).toBeVisible();
    await expect(adding).toBeDisabled();

    gate.releaseHeldServerMessage("set_daemon_config_response");
    await expect(sheet).toBeHidden({ timeout: 30_000 });
    await removeCustomModel(page, MODEL_ID);
  });

  test("shows the diagnostic report running again on its re-run button", async ({ page }) => {
    const gate = await installDaemonWebSocketGate(page);
    await openCustomModels(page);

    await page.getByRole("button", { name: "Diagnostic report", exact: true }).click();
    const sheet = page.getByTestId("provider-diagnostic-sheet");
    const rerun = sheet.getByRole("button", { name: "Refresh diagnostic", exact: true });
    await expect(rerun).toBeEnabled({ timeout: 30_000 });
    // Copy has a report to copy once the first run is in.
    await expect(sheet.getByRole("button", { name: "Copy diagnostic" })).toBeEnabled();

    gate.holdNextServerMessage("provider_diagnostic_response");
    await rerun.click();
    await gate.waitForHeldServerMessage("provider_diagnostic_response");

    const running = sheet.getByRole("button", { name: "Refreshing diagnostic", exact: true });
    await expect(running.getByRole("progressbar")).toBeVisible();
    await expect(running).toBeDisabled();

    gate.releaseHeldServerMessage("provider_diagnostic_response");
    await expect(rerun).toBeEnabled({ timeout: 30_000 });
  });
});
