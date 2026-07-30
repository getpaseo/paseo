import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "./fixtures";
import { submitMessage } from "./helpers/composer";
import { cleanupRewindFlow, launchAgent, type AgentHandle } from "./helpers/rewind-flow";

test.describe("Codex out-of-band commands", () => {
  test.setTimeout(300_000);

  test("settles the submitted row when a goal command completes without a turn", async ({
    page,
  }) => {
    const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "paseo-codex-command-")));
    let handle: AgentHandle | undefined;

    try {
      handle = await launchAgent({ page, provider: "codex", cwd, mode: "full-access" });
      await submitMessage(page, "/goal clear");
      const command = page.getByTestId("user-message").filter({ hasText: "/goal clear" });

      await expect(command).toBeVisible();
      await expect(command).toHaveAttribute("aria-busy", "false", { timeout: 30_000 });
      await expect(page.getByTestId("turn-working-indicator")).toHaveCount(0);
    } finally {
      await cleanupRewindFlow({ handle, cwd });
    }
  });
});
