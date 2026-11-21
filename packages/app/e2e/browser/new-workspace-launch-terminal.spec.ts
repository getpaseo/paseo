import { expect, test, type Page } from "../support/fixtures";
import { decodeWorkspaceIdFromPathSegment } from "@/utils/host-routes";
import { reloadPreservingHostRegistry } from "../support/helpers/hosts";
import { projectPlacementViewKey } from "../support/helpers/project-view-key";
import { getServerId } from "../support/helpers/server-id";
import { gotoAppShell } from "../support/helpers/app";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";
import {
  connectNewWorkspaceDaemonClient,
  expectNewWorkspaceProjectSelected,
  expectNewWorkspaceDraft,
  fillNewWorkspaceDraft,
  openNewWorkspaceComposer,
  selectNewWorkspaceProject,
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

const MISSING_PROFILE: TerminalProfile = {
  id: "e2e-missing-command",
  name: "Missing Command",
  command: "/paseo-e2e-missing-terminal",
  args: [],
};

test.use({
  e2eDaemonConfig: {
    version: 1,
    daemon: { terminalProfiles: [PROMPT_PROFILE, BARE_PROFILE, MISSING_PROFILE] },
  },
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

  test("preserves a terminal launch and its command when changing project", async ({ page }) => {
    const otherProject = await seedWorkspace({ repoPrefix: "terminal-project-change-" });
    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openNewWorkspaceComposer(page, workspace);
      await selectLaunchOption(page, PROMPT_PROFILE.id);
      await fillTerminalPrompt(page, "keep this command on the chosen project");
      await selectNewWorkspaceProject(page, otherProject);
      await expectTerminalLaunchSelected(page, PROMPT_PROFILE.name);
      await expect(terminalPromptInput(page)).toHaveValue(
        "keep this command on the chosen project",
      );
    } finally {
      await otherProject.cleanup();
    }
  });

  test("sidebar requests replace a manually selected project", async ({ page }) => {
    const otherProject = await seedWorkspace({ repoPrefix: "sidebar-project-request-" });
    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openNewWorkspaceComposer(page, workspace);
      await selectNewWorkspaceProject(page, otherProject);
      await expectNewWorkspaceProjectSelected(page, otherProject.projectDisplayName);
      await openNewWorkspaceComposer(page, workspace);
      await expectNewWorkspaceProjectSelected(page, workspace.projectDisplayName);
    } finally {
      await otherProject.cleanup();
    }
  });

  test("retry after a failed terminal launch uses the newly selected project", async ({ page }) => {
    const otherProject = await seedWorkspace({ repoPrefix: "terminal-retry-project-" });
    const client = await connectNewWorkspaceDaemonClient();
    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openNewWorkspaceComposer(page, workspace);
      await selectLaunchOption(page, MISSING_PROFILE.id);
      await submitTerminalLaunch(page);
      await expect(
        page.getByText(/paseo-e2e-missing-terminal.*command not found/).first(),
      ).toBeVisible();
      await selectNewWorkspaceProject(page, otherProject);
      await selectLaunchOption(page, PROMPT_PROFILE.id);
      await fillTerminalPrompt(page, "retry on the newly selected project");
      await submitTerminalLaunch(page);
      await expectWorkspaceOpensWithTerminalTab(page);
      await expectTerminalOutputContains(page, "captured: retry on the newly selected project");
      const workspaceSegment = new URL(page.url()).pathname.split("/").at(-1)!;
      const workspaceId = decodeWorkspaceIdFromPathSegment(workspaceSegment);
      const created = (await client.fetchWorkspaces()).entries.find(
        (entry) => entry.id === workspaceId,
      );
      expect(created?.projectId).toBe(otherProject.projectId);
    } finally {
      await client.close();
      await otherProject.cleanup();
    }
  });

  for (const roundTrip of [false, true]) {
    test(`cached terminal retry ${roundTrip ? "after a project round trip" : "without changing project"} reuses the original workspace`, async ({
      page,
    }) => {
      test.setTimeout(90_000);
      const otherProject = roundTrip
        ? await seedWorkspace({ repoPrefix: "terminal-placement-roundtrip-" })
        : undefined;
      const client = await connectNewWorkspaceDaemonClient();
      try {
        await gotoAppShell(page);
        await waitForSidebarHydration(page);
        await openNewWorkspaceComposer(page, workspace);
        await selectLaunchOption(page, MISSING_PROFILE.id);
        await submitTerminalLaunch(page);
        await expect(
          page.getByText(/paseo-e2e-missing-terminal.*command not found/).first(),
        ).toBeVisible();
        const cachedWorkspace = (await client.fetchWorkspaces()).entries.find(
          (entry) => entry.projectId === workspace.projectId && entry.id !== workspace.workspaceId,
        );
        expect(cachedWorkspace).toBeDefined();
        if (otherProject) {
          await selectNewWorkspaceProject(page, otherProject);
          await selectNewWorkspaceProject(page, workspace);
        }
        await expectNewWorkspaceProjectSelected(page, workspace.projectDisplayName);
        await selectLaunchOption(page, PROMPT_PROFILE.id);
        await fillTerminalPrompt(page, "retry the existing workspace with a corrected profile");
        await submitTerminalLaunch(page);
        await expectWorkspaceOpensWithTerminalTab(page);
        await expectTerminalOutputContains(
          page,
          "captured: retry the existing workspace with a corrected profile",
        );
        const workspaceId = decodeWorkspaceIdFromPathSegment(
          new URL(page.url()).pathname.split("/").at(-1)!,
        );
        expect(workspaceId).toBe(cachedWorkspace!.id);
        expect(
          (await client.fetchWorkspaces()).entries.filter(
            (entry) => entry.projectId === workspace.projectId,
          ),
        ).toHaveLength(2);
      } finally {
        await client.close();
        await otherProject?.cleanup();
      }
    });
  }

  test("explicit draft retries preserve placement identity after reload", async ({ page }) => {
    test.setTimeout(90_000);
    const otherProject = await seedWorkspace({ repoPrefix: "explicit-draft-retry-" });
    const client = await connectNewWorkspaceDaemonClient();
    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openNewWorkspaceComposer(page, workspace);
      const draftUrl = new URL(page.url());
      draftUrl.searchParams.set("draftId", `explicit-retry-${workspace.workspaceId}`);
      await page.goto(draftUrl.toString());
      await expectNewWorkspaceProjectSelected(page, workspace.projectDisplayName);
      await page.getByTestId("workspace-create-isolation-trigger").click();
      await page.getByTestId("workspace-create-isolation-worktree").click();
      await selectLaunchOption(page, MISSING_PROFILE.id);
      await submitTerminalLaunch(page);
      await expect(
        page.getByText(/paseo-e2e-missing-terminal.*command not found/).first(),
      ).toBeVisible();
      await selectNewWorkspaceProject(page, otherProject);
      // B has not submitted yet; reload must not reuse A's request key.
      await expect
        .poll(() => new URL(page.url()).searchParams.get("projectId"))
        .toBe(otherProject.projectId);
      await reloadPreservingHostRegistry(page);
      await expectNewWorkspaceProjectSelected(page, otherProject.projectDisplayName);
      await selectLaunchOption(page, PROMPT_PROFILE.id);
      await fillTerminalPrompt(page, "retry the explicit draft after reload");
      await submitTerminalLaunch(page);
      await expectWorkspaceOpensWithTerminalTab(page);
      await expectTerminalOutputContains(page, "captured: retry the explicit draft after reload");
      const workspaceId = decodeWorkspaceIdFromPathSegment(
        new URL(page.url()).pathname.split("/").at(-1)!,
      );
      expect(workspaceId).not.toBe(otherProject.workspaceId);
      const created = (await client.fetchWorkspaces()).entries.find(
        (entry) => entry.id === workspaceId,
      );
      expect(created?.projectId).toBe(otherProject.projectId);
    } finally {
      await client.close();
      await otherProject.cleanup();
    }
  });

  test("clone registration preserves the cached workspace for a terminal retry", async ({
    page,
  }) => {
    const originUrl = "https://github.com/getpaseo/terminal-retry-fixture.git";
    const selected = await seedWorkspace({
      repoPrefix: "terminal-grouping-primary-",
      repo: { originUrl },
    });
    let duplicate: SeededWorkspace | undefined;
    const client = await connectNewWorkspaceDaemonClient();
    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openNewWorkspaceComposer(page, selected);
      await selectLaunchOption(page, MISSING_PROFILE.id);
      await submitTerminalLaunch(page);
      await expect(
        page.getByText(/paseo-e2e-missing-terminal.*command not found/).first(),
      ).toBeVisible();
      const cachedWorkspace = (await client.fetchWorkspaces()).entries.find(
        (entry) => entry.projectId === selected.projectId && entry.id !== selected.workspaceId,
      );
      expect(cachedWorkspace).toBeDefined();
      duplicate = await seedWorkspace({
        repoPrefix: "terminal-grouping-clone-",
        repo: { originUrl },
      });
      await expect(
        page.getByTestId(
          `sidebar-project-row-${projectPlacementViewKey(getServerId(), selected.projectId)}`,
        ),
      ).toBeVisible();
      await selectLaunchOption(page, PROMPT_PROFILE.id);
      await fillTerminalPrompt(page, "retry the same checkout after adding a clone");
      await submitTerminalLaunch(page);
      await expectWorkspaceOpensWithTerminalTab(page);
      await expectTerminalOutputContains(
        page,
        "captured: retry the same checkout after adding a clone",
      );
      const workspaceId = decodeWorkspaceIdFromPathSegment(
        new URL(page.url()).pathname.split("/").at(-1)!,
      );
      expect(workspaceId).toBe(cachedWorkspace!.id);
    } finally {
      await client.close();
      await duplicate?.cleanup();
      await selected.cleanup();
    }
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

    // Exercise the terminal prompt's fullscreen and compact launch sheet on the phone.
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
