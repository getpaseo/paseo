import { test } from "../support/helpers/codex-workspace-restore";

test.use({
  e2eDaemonConfig: { version: 1, daemon: { mcp: { enabled: true } } },
  trace: "on",
  video: "on",
});
test.describe.configure({ timeout: 600_000 });

test("a fresh client restores an archived Codex agent across a reload without agent cache", async ({
  codexRestore,
}) => {
  await test.step("Create, finish, and archive Codex before this browser connects", async () => {
    await codexRestore.createWorktreeWithCodex();
    await codexRestore.archiveBeforeBrowserConnects();
  });
  await test.step("Connect the fresh browser, open History, and restore the workspace", async () => {
    await codexRestore.connectFreshBrowser();
    await codexRestore.openArchivedWorkspaceFromHistory();
    await codexRestore.restoreWorkspace();
    await codexRestore.expectArchivedAgentSelectedWithHistory();
  });
  await test.step("Reload without cached agent data and keep the selected archived agent", async () => {
    await codexRestore.reloadWithoutAgentCache();
    await codexRestore.waitForWorkspaceHydration();
    await codexRestore.expectArchivedAgentSelectedWithHistory();
  });
  await test.step("Unarchive the agent and keep its idle composer after another cache-empty reload", async () => {
    await codexRestore.unarchiveAgent();
    await codexRestore.reloadWithoutAgentCache();
    await codexRestore.expectIdleAgentWithVisibleComposer();
  });
});

test("restore an archived worktree, then unarchive its completed Codex agent", async ({
  codexRestore,
}) => {
  await test.step("1. Create a managed worktree with a real Codex agent through Paseo MCP", async () => {
    await codexRestore.createWorktreeWithCodex();
  });
  await test.step("2. Wait for Codex to finish and show its reply", async () => {
    await codexRestore.waitForCompletedReply();
  });
  await test.step("3. Archive the workspace from its sidebar menu", async () => {
    await codexRestore.archiveWorkspaceFromSidebar();
  });
  await test.step("4. Assert workspace and agent are archived and the worktree is removed", async () => {
    await codexRestore.expectWorkspaceAndAgentArchived();
  });
  await test.step("5. Open the archived workspace from History", async () => {
    await codexRestore.openArchivedWorkspaceFromHistory();
  });
  await test.step("6. Restore the workspace", async () => {
    await codexRestore.restoreWorkspace();
    await codexRestore.expectWorktreeRestoredWithArchivedAgentSelected();
  });
  await test.step("7. Click Unarchive on the agent", async () => {
    await codexRestore.unarchiveAgent();
  });
  await test.step("8. Expect an idle agent with a visible editable composer", async () => {
    await codexRestore.expectIdleAgentWithVisibleComposer(60_000);
  });
});
