import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type Page } from "../support/fixtures";
import { launchAgent, cleanupRewindFlow, type AgentHandle } from "../support/helpers/rewind-flow";
import { submitMessage } from "../support/helpers/composer";

const binary = process.env.OPENCODE_TEST_BINARY ?? "opencode";
test.use({
  e2eDaemonConfig: {
    version: 1,
    agents: { providers: { opencode: { enabled: true, command: [binary] } } },
  },
});

async function selectMedium(page: Page) {
  await page
    .getByRole("button", { name: /^Select thinking option/ })
    .filter({ visible: true })
    .click();
  await page.getByText("Medium", { exact: true }).filter({ visible: true }).click();
  await expect(
    page
      .getByRole("button", { name: "Select thinking option (Medium)", exact: true })
      .filter({ visible: true }),
  ).toBeVisible();
}
async function selectLongcat(page: Page) {
  await page
    .getByRole("button", { name: /^Select model \(/ })
    .filter({ visible: true })
    .click();
  await page
    .getByText("LongCat 2.5 Preview Free", { exact: true })
    .filter({ visible: true })
    .click();
}
async function askForReply(handle: AgentHandle) {
  await submitMessage(handle.page, "Reply exactly OK. Do not use tools.");
  return handle.client.waitForFinish(handle.agentId, 120_000);
}

test("switching an existing OpenCode session clears unsupported thinking", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const cwd = mkdtempSync(path.join(tmpdir(), "paseo-variant-ui-"));
  let handle: AgentHandle | undefined;
  try {
    handle = await launchAgent({
      page,
      cwd,
      provider: "opencode",
      mode: "full-access",
      providerConfig: { model: "opencode/space-bunny-free" },
    });
    await selectMedium(page);
    expect((await askForReply(handle)).status).toBe("idle");
    await selectLongcat(page);
    await expect(
      page.getByRole("button", { name: /^Select thinking option/ }).filter({ visible: true }),
    ).toHaveCount(0);
    const finish = await askForReply(handle);
    const screenshot = testInfo.outputPath("model-switch.png");
    await page.screenshot({ path: screenshot });
    await testInfo.attach("After switching to Longcat", {
      path: screenshot,
      contentType: "image/png",
    });
    expect(finish.status).toBe("idle");
    expect(finish.final?.lastError).toBeFalsy();
    await expect(
      page.getByTestId("assistant-message").filter({ visible: true }).last(),
    ).toContainText("OK");
  } finally {
    await cleanupRewindFlow({ handle, cwd });
  }
});
