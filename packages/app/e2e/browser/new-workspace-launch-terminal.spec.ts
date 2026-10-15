import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";
import {
  expectNewWorkspaceDraft,
  fillNewWorkspaceDraft,
  openNewWorkspaceComposer,
} from "../support/helpers/new-workspace";
import {
  composerLocator,
  enterComposerFullscreen,
  exitComposerFullscreen,
  expectComposerFullscreenControls,
  resizeComposerViewport,
} from "../support/helpers/composer";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import {
  expectTerminalLaunchSelected,
  expectTerminalOutputContains,
  expectTerminalPreviewCommand,
  expectWorkspaceOpensWithTerminalTab,
  fillTerminalPrompt,
  launchTrigger,
  selectLaunchOption,
  submitTerminalLaunch,
  terminalLaunchSubmit,
  terminalPromptInput,
  type TerminalProfile,
} from "../support/helpers/new-workspace-launch";

// Someone who wants a terminal agent instead of a chat: they pick a profile
// from the meta-row control, type a prompt, and the daemon actually spawns the
// resolved command with their prompt substituted in — no mocking Paseo's own
// code, the "profile" here is a real, harmless binary the daemon really runs.
//
// The sentinel becomes `$0` (a positional shell parameter, not string
// interpolation into the script source), so the prompt reaches the process
// exactly as typed with no injection risk. `cat` waits for input until project
// cleanup kills the terminal, so attachment does not race a fixed process lifetime.
const PROMPT_PROFILE: TerminalProfile = {
  id: "e2e-echo-prompt",
  name: "Echo Prompt",
  command: "/bin/sh",
  args: ["-c", 'echo captured: "$0"; exec cat', "{{{prompt}}}"],
};

// No sentinel anywhere: takes no prompt, composer goes read-only.
const BARE_PROFILE: TerminalProfile = {
  id: "e2e-echo-bare",
  name: "Bare Echo",
  command: "/bin/sh",
  args: ["-c", "echo bare-launch-static-line; exec cat"],
};

test.use({
  e2eDaemonConfig: { version: 1, daemon: { terminalProfiles: [PROMPT_PROFILE, BARE_PROFILE] } },
});

test.describe("New workspace: launching a terminal", () => {
  let workspace: SeededWorkspace;

  test.beforeEach(async () => {
    workspace = await seedWorkspace({ repoPrefix: "launch-terminal-" });
  });

  test.afterEach(async () => {
    await workspace?.cleanup();
  });

  test("a profile that takes a prompt launches with it as its trailing argument; a profile without the sentinel launches bare from Launch", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await gotoAppShell(page);
    await waitForSidebarHydration(page);

    await test.step("pick a profile that takes a prompt, type one, and submit", async () => {
      await openNewWorkspaceComposer(page, {
        projectKey: workspace.projectKey,
        projectDisplayName: workspace.projectDisplayName,
      });
      await selectLaunchOption(page, PROMPT_PROFILE.id);
      await expectTerminalLaunchSelected(page, PROMPT_PROFILE.name);

      await fillTerminalPrompt(page, "fix the flaky test");
      await submitTerminalLaunch(page);
    });

    await test.step("the workspace opens with a terminal tab, and the profile received the prompt", async () => {
      await expectWorkspaceOpensWithTerminalTab(page);
      await expectTerminalOutputContains(page, "captured: fix the flaky test");
    });

    await test.step("a profile without the sentinel is read-only and shows the resolved command", async () => {
      await openNewWorkspaceComposer(page, {
        projectKey: workspace.projectKey,
        projectDisplayName: workspace.projectDisplayName,
      });
      await selectLaunchOption(page, BARE_PROFILE.id);
      await expect(terminalPromptInput(page)).toHaveCount(0);
      await expectTerminalPreviewCommand(page, "/bin/sh -c echo bare-launch-static-line; exec cat");
      await expect(terminalLaunchSubmit(page)).toHaveText("Launch");
    });

    await test.step("Launch starts the profile bare, with no prompt to send", async () => {
      await submitTerminalLaunch(page);
      await expectWorkspaceOpensWithTerminalTab(page);
      await expectTerminalOutputContains(page, "bare-launch-static-line");
    });
  });

  test("switching terminal profiles restores the prompt and its fullscreen affordance", async ({
    page,
  }) => {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await openNewWorkspaceComposer(page, {
      projectKey: workspace.projectKey,
      projectDisplayName: workspace.projectDisplayName,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    const prompt = "First replacement line\nSecond replacement line\nThird replacement line";
    const selectProfile = async (profile: TerminalProfile) => {
      await launchTrigger(page).click();
      const option = page.getByRole("menuitem").filter({ hasText: profile.name });
      await option.click();
      await expect(option).not.toBeVisible();
    };
    const fullscreen = page.getByRole("button", { name: "Fullscreen", exact: true });

    await test.step("restore a multiline prompt after a read-only profile", async () => {
      await selectProfile(PROMPT_PROFILE);
      await fillTerminalPrompt(page, prompt);
      await expect(fullscreen).toBeVisible();
      await selectProfile(BARE_PROFILE);
      await expect(terminalPromptInput(page)).toHaveCount(0);
      await selectProfile(PROMPT_PROFILE);
      await expect(terminalPromptInput(page)).toHaveValue(prompt);
      await expect(fullscreen).toBeVisible();
    });

    await test.step("restore the locally edited prompt and measure subsequent typing", async () => {
      await fillTerminalPrompt(page, "Short draft");
      await expect(fullscreen).toHaveCount(0);
      await selectProfile(BARE_PROFILE);
      await selectProfile(PROMPT_PROFILE);
      await expect(terminalPromptInput(page)).toHaveValue("Short draft");
      await expect(fullscreen).toHaveCount(0);
      await terminalPromptInput(page).press("End");
      await terminalPromptInput(page).press("Shift+Enter");
      await terminalPromptInput(page).pressSequentially("Second");
      await terminalPromptInput(page).press("Shift+Enter");
      await terminalPromptInput(page).pressSequentially("Third");
      await expect(terminalPromptInput(page)).toHaveValue("Short draft\nSecond\nThird");
      await expect(fullscreen).toBeVisible();
    });
  });
});

async function expectNewWorkspaceHeaderHidden(page: Page): Promise<void> {
  await expect(page.getByTestId("menu-button").filter({ visible: true })).toHaveCount(0);
}

async function expectNewWorkspaceHeaderVisible(page: Page): Promise<void> {
  await expect(page.getByTestId("menu-button").filter({ visible: true }).first()).toBeVisible();
}

/**
 * Fullscreen fills the content area top to bottom and out to the right edge (a pinned
 * sidebar keeps its column), covers the form, and shows only exit and the mode's submit.
 */
async function expectNewWorkspaceFullscreen(page: Page, submitLabel: string): Promise<void> {
  const frame = page.getByTestId("composer-fullscreen");
  await expect(page.getByRole("button", { name: "Exit fullscreen", exact: true })).toBeVisible();
  await expect(frame.getByRole("button")).toHaveCount(2);
  await expect(frame.getByRole("button", { name: submitLabel })).toBeVisible();
  await expectNewWorkspaceHeaderHidden(page);
  const picker = (await page.getByRole("button", { name: "Workspace project" }).boundingBox())!;
  await expect
    .poll(() =>
      frame.evaluate(
        (element, point) => {
          const viewport = window.visualViewport!;
          const box = element.getBoundingClientRect();
          const covering = document.elementFromPoint(point.x, point.y);
          return {
            fillsHeight:
              Math.abs(box.top - viewport.offsetTop) < 1 &&
              Math.abs(box.height - viewport.height) < 1,
            reachesRightEdge:
              Math.abs(box.right - (viewport.offsetLeft + viewport.width)) < 1 &&
              box.left >= viewport.offsetLeft,
            coversForm: element.contains(covering),
          };
        },
        { x: picker.x + picker.width / 2, y: picker.y + picker.height / 2 },
      ),
    )
    .toEqual({ fillsHeight: true, reachesRightEdge: true, coversForm: true });
}

test.describe("New workspace: fullscreen composer across the compact breakpoint", () => {
  let workspace: SeededWorkspace;

  test.beforeEach(async () => {
    workspace = await seedWorkspace({ repoPrefix: "launch-fullscreen-" });
  });

  test.afterEach(async () => {
    await workspace?.cleanup();
  });

  test("chat fullscreen survives widening and terminal fullscreen fills the phone", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await openNewWorkspaceComposer(page, {
      projectKey: workspace.projectKey,
      projectDisplayName: workspace.projectDisplayName,
    });
    const projectPicker = page.getByRole("button", { name: "Workspace project" });

    await test.step("chat: fullscreen covers the centered form and exits back into it", async () => {
      await resizeComposerViewport(page, "portrait");
      const draft = "Chat first line\nChat second line\nChat third line";
      await fillNewWorkspaceDraft(page, draft);
      await enterComposerFullscreen(page);
      await expectComposerFullscreenControls(page);
      await expectNewWorkspaceHeaderHidden(page);
      await resizeComposerViewport(page, "landscape");
      await expectComposerFullscreenControls(page);
      await expectNewWorkspaceFullscreen(page, "Create");
      // The desktop form's own import button is dropped from the fullscreen slot.
      await expect(
        page.getByTestId("new-workspace-import-session").filter({ visible: true }),
      ).toHaveCount(0);
      await composerLocator(page).press("End");
      await composerLocator(page).pressSequentially(" wide");
      await exitComposerFullscreen(page);
      await expectNewWorkspaceHeaderVisible(page);
      await expect(projectPicker).toBeVisible();
      await expect(
        page.getByTestId("new-workspace-import-session").filter({ visible: true }),
      ).toBeVisible();
      await expectNewWorkspaceDraft(page, `${draft} wide`);
    });

    // Terminal mode and its prompt are screen state, and the shell remounts the screen
    // at the breakpoint, so the terminal prompt's fullscreen is exercised on the phone
    // layout only.
    await test.step("terminal: the prompt's fullscreen shows only exit and Launch", async () => {
      await resizeComposerViewport(page, "portrait");
      // The compact launch control opens a sheet, not the desktop menu.
      await launchTrigger(page).click();
      const option = page.getByRole("menuitem").filter({ hasText: PROMPT_PROFILE.name });
      await option.click();
      await expect(option).not.toBeVisible();
      await expectTerminalLaunchSelected(page, PROMPT_PROFILE.name);
      const prompt = "Prompt first line\nPrompt second line\nPrompt third line";
      await fillTerminalPrompt(page, prompt);
      await enterComposerFullscreen(page);
      await expect(terminalPromptInput(page)).toBeVisible();
      await expectNewWorkspaceFullscreen(page, "Launch");
      await exitComposerFullscreen(page);
      await expectNewWorkspaceHeaderVisible(page);
      await expect(projectPicker).toBeVisible();
      await expect(terminalPromptInput(page)).toHaveValue(prompt);
    });
  });
});
