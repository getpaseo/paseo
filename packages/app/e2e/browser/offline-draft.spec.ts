import { expect, test } from "../support/fixtures";
import { expectComposerModel } from "../support/helpers/agent-profiles";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import { createAgentTabFromMenu } from "../support/helpers/workspace-tabs";
import { submitMessage } from "../support/helpers/composer";

async function restoreHostConnection(gate: Awaited<ReturnType<typeof installDaemonWebSocketGate>>) {
  gate.holdNextServerMessage("status");
  gate.restore();
  await gate.waitForHeldServerMessage("status");
  gate.releaseHeldServerMessage("status");
}

test("an offline workspace draft reports the disconnected host instead of loading models", async ({
  page,
  withWorkspace,
}) => {
  const gate = await installDaemonWebSocketGate(page);
  const workspace = await withWorkspace();
  await workspace.navigateTo();
  await gate.drop();
  await gate.waitForBlockedConnection();
  await createAgentTabFromMenu(page);
  await submitMessage(page, "hello");
  await expect(page.getByRole("alert").filter({ hasText: "Host is not connected" })).toHaveText(
    "Host is not connected",
  );
  await expect(page.getByText("Loading...", { exact: true })).toHaveCount(0);
  await restoreHostConnection(gate);
  await expectComposerModel(page, "Ten second stream");
  await expect(page.getByRole("textbox", { name: "Message agent..." })).toHaveValue("hello");
});
