import { test, expect, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";
import {
  openNewWorkspaceComposer,
  submitNewWorkspacePrompt,
} from "../support/helpers/new-workspace";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import {
  expectChatLaunchSelected,
  expectTerminalLaunchSelected,
  expectTerminalOutputContains,
  expectWorkspaceOpensWithTerminalTab,
  fillTerminalPrompt,
  patchTerminalProfiles,
  seedTerminalProfiles,
  selectChatLaunch,
  selectLaunchOption,
  submitTerminalLaunch,
  type TerminalProfile,
  type TerminalProfileSeed,
} from "../support/helpers/new-workspace-launch";

// Wait for input until project cleanup kills the terminal. A fixed lifetime
// can expire before a busy browser attaches or finishes revisiting the composer.
const PROMPT_PROFILE: TerminalProfile = {
  id: "e2e-memory-profile",
  name: "Memory Profile",
  command: "/bin/sh",
  args: ["-c", 'echo remembered: "$0"; exec cat', "{{{prompt}}}"],
};

async function expectChatLaunchComplete(page: Page): Promise<void> {
  const agentTab = page.getByTestId(/^workspace-tab-agent_/).filter({ visible: true });
  await expect(agentTab).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
}

test.describe("New workspace: launch target memory", () => {
  let workspace: SeededWorkspace;
  let profileSeed: TerminalProfileSeed;

  test.beforeEach(async () => {
    workspace = await seedWorkspace({ repoPrefix: "launch-memory-" });
    profileSeed = await seedTerminalProfiles([PROMPT_PROFILE]);
  });

  test.afterEach(async () => {
    await profileSeed.restore();
    await workspace?.cleanup();
  });

  test("remembers the launch target across visits, and a removed profile falls back to chat instead of a dead entry", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await gotoAppShell(page);
    await waitForSidebarHydration(page);

    const openNewWorkspace = () =>
      openNewWorkspaceComposer(page, {
        projectKey: workspace.projectKey,
        projectDisplayName: workspace.projectDisplayName,
      });

    await test.step("launching a terminal profile preselects it the next time New workspace opens", async () => {
      await openNewWorkspace();
      await selectLaunchOption(page, PROMPT_PROFILE.id);
      await expectTerminalLaunchSelected(page, PROMPT_PROFILE.name);
      await fillTerminalPrompt(page, "remember me");
      await submitTerminalLaunch(page);
      await expectWorkspaceOpensWithTerminalTab(page);
      await expectTerminalOutputContains(page, "remembered: remember me");

      await openNewWorkspace();
      await expectTerminalLaunchSelected(page, PROMPT_PROFILE.name);
    });

    await test.step("switching to Chat and submitting preselects Chat the next time", async () => {
      await selectChatLaunch(page);
      await expectChatLaunchSelected(page);
      await submitNewWorkspacePrompt(page, "hello from chat");
      // Leaving /new can expose a previous workspace before the submitted draft opens.
      await expectChatLaunchComplete(page);

      await openNewWorkspace();
      await expectChatLaunchSelected(page);
    });

    await test.step("re-selecting the terminal profile, then removing it daemon-side, falls back to Chat rather than a dead entry", async () => {
      await selectLaunchOption(page, PROMPT_PROFILE.id);
      await expectTerminalLaunchSelected(page, PROMPT_PROFILE.name);
      await fillTerminalPrompt(page, "second run");
      await submitTerminalLaunch(page);
      await expectWorkspaceOpensWithTerminalTab(page);

      await patchTerminalProfiles([]);

      await openNewWorkspace();
      await expectChatLaunchSelected(page);
    });
  });
});
