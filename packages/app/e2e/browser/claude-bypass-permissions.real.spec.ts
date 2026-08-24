import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { submitMessage } from "../support/helpers/composer";
import { cleanupRewindFlow, type AgentHandle, launchAgent } from "../support/helpers/rewind-flow";

const FILE_NAME = "BYPASS.md";
const FILE_CONTENT = "PASEO_BYPASS_PLAYWRIGHT_OK\n";
const COMPLETION = "BYPASS_WRITE_COMPLETE";

function configureClaudeToAskForFileTools(handle: AgentHandle): void {
  const settingsDirectory = path.join(handle.cwd, ".claude");
  mkdirSync(settingsDirectory);
  writeFileSync(
    path.join(settingsDirectory, "settings.local.json"),
    `${JSON.stringify({ permissions: { ask: ["Bash", "Write", "Edit"] } }, null, 2)}\n`,
  );
}

async function switchClaudeToBypassPermissions(handle: AgentHandle): Promise<void> {
  const modeControl = handle.page.getByRole("button", { name: /^Select agent mode \(/ });
  await expect(modeControl).toHaveAccessibleName("Select agent mode (Always ask)");
  await modeControl.click();

  const modePicker = handle.page.getByTestId("combobox-desktop-container").last();
  await expect(modePicker).toBeVisible();
  await modePicker.getByText("Bypass", { exact: true }).click();
  await expect(modeControl).toHaveAccessibleName("Select agent mode (Bypass)");
}

async function askClaudeToWriteWithoutApproval(handle: AgentHandle): Promise<void> {
  await submitMessage(
    handle.page,
    `Call the Write tool exactly once to create ${FILE_NAME} with exactly ${JSON.stringify(
      FILE_CONTENT,
    )}. Do not use Bash or another tool. After Write succeeds, reply exactly ${COMPLETION}.`,
  );
}

async function expectBypassWriteToComplete(handle: AgentHandle): Promise<void> {
  await expect(
    handle.page.getByTestId("assistant-message").filter({ hasText: COMPLETION }).last(),
  ).toBeVisible({ timeout: 120_000 });
  await expect(handle.page.getByTestId("permission-request-question")).toHaveCount(0);
  await expect.poll(() => existsSync(path.join(handle.cwd, FILE_NAME))).toBe(true);
  await expect
    .poll(() => readFileSync(path.join(handle.cwd, FILE_NAME), "utf8"))
    .toBe(FILE_CONTENT);
}

test.describe("real Claude bypass permissions", () => {
  test.setTimeout(240_000);

  test("honors Bypass when project policy asks to approve Write", async ({ page }, testInfo) => {
    const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "paseo-claude-bypass-")));
    let handle: AgentHandle | undefined;

    try {
      handle = await launchAgent({
        page,
        provider: "claude",
        cwd,
        mode: "full-access",
        providerConfig: { modeId: "default" },
      });
      configureClaudeToAskForFileTools(handle);
      await switchClaudeToBypassPermissions(handle);
      await askClaudeToWriteWithoutApproval(handle);
      await expectBypassWriteToComplete(handle);
      await page.screenshot({ path: testInfo.outputPath("claude-bypass-write-complete.png") });
    } finally {
      await cleanupRewindFlow({ handle, cwd });
    }
  });
});
