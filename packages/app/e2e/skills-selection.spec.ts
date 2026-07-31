import { test as base } from "./fixtures";
import { gotoAppShell } from "./helpers/app";
import { injectDesktopBridge } from "./helpers/desktop-updates";
import { getServerId } from "./helpers/server-id";
import {
  cancelSkillSelection,
  chooseAllSkills,
  chooseCustomSkills,
  createSkillsSandbox,
  expectAllSkillsSelected,
  expectNoRemovalWarning,
  expectRemovalWarning,
  expectSavedSkillSelection,
  expectSaveErrorKeepsSheetOpen,
  expectSelectedSkills,
  expectSkillFilePresent,
  expectSkillPresentIn,
  expectSkillSelectionOpen,
  expectSkillsInstalled,
  openSkillsIntegrations,
  openSkillSelection,
  saveSkillSelection,
  toggleSkill,
  serveRealSkillsCommands,
  type SkillsSandbox,
  type SkillsSandboxOptions,
} from "./helpers/skills-selection";

interface SkillsSandboxSetup extends SkillsSandboxOptions {
  /** What the desktop confirm dialog answers when the removal warning fires. */
  confirmRemoval?: boolean;
}

type StartSkills = (setup?: SkillsSandboxSetup) => Promise<SkillsSandbox>;

// Every skills command runs against the real desktop handlers over a temp bundle
// and temp user data, so the assertions cover persistence and convergence, not a
// browser stand-in for them.
const test = base.extend<{ startSkills: StartSkills }>({
  startSkills: async ({ page }, provide) => {
    const sandboxes: SkillsSandbox[] = [];
    await provide(async (setup = {}) => {
      const { confirmRemoval, ...options } = setup;
      const sandbox = await createSkillsSandbox(options);
      await injectDesktopBridge(page, {
        serverId: getServerId(),
        confirmShouldAccept: confirmRemoval ?? false,
      });
      await serveRealSkillsCommands(page, sandbox);
      sandboxes.push(sandbox);
      return sandbox;
    });
    for (const sandbox of sandboxes) {
      await sandbox.cleanup();
    }
  },
});

test.describe("Choosing installed skills", () => {
  test("installs only the skills selected in Settings", async ({ page, startSkills }) => {
    const skills = await startSkills();
    await gotoAppShell(page);
    await openSkillsIntegrations(page);

    await openSkillSelection(page);
    await chooseCustomSkills(page, ["paseo", "paseo-loop"]);
    await saveSkillSelection(page);

    await expectSkillsInstalled(skills, ["paseo", "paseo-loop"]);
    await expectSelectedSkills(page, ["paseo", "paseo-loop"]);
  });

  test("all skills includes every available skill", async ({ page, startSkills }) => {
    const skills = await startSkills();
    await gotoAppShell(page);
    await openSkillsIntegrations(page);
    await openSkillSelection(page);
    await chooseCustomSkills(page, ["paseo"]);
    await saveSkillSelection(page);

    await openSkillSelection(page);
    await chooseAllSkills(page);
    await saveSkillSelection(page);

    await expectSkillsInstalled(skills, skills.bundledSkills);
    await expectAllSkillsSelected(page);
  });

  test("cancelling leaves the installed skills untouched", async ({ page, startSkills }) => {
    const skills = await startSkills();
    await gotoAppShell(page);
    await openSkillsIntegrations(page);
    await openSkillSelection(page);
    await chooseCustomSkills(page, ["paseo"]);
    await saveSkillSelection(page);

    await openSkillSelection(page);
    await toggleSkill(page, "paseo-loop");
    await cancelSkillSelection(page);

    await expectSkillsInstalled(skills, ["paseo"]);
    await expectSelectedSkills(page, ["paseo"]);
  });

  test("a failed save keeps the sheet open with an error", async ({ page, startSkills }) => {
    const skills = await startSkills({ blockAgentsDir: true });
    await gotoAppShell(page);
    await openSkillsIntegrations(page);

    await openSkillSelection(page);
    await chooseCustomSkills(page, ["paseo"]);
    await saveSkillSelection(page);

    await expectSaveErrorKeepsSheetOpen(page);
    await expectSkillsInstalled(skills, []);
  });
});

test.describe("Removing an installed skill", () => {
  test("warns before deleting the skill folders", async ({ page, startSkills }) => {
    const skills = await startSkills({ installed: { mode: "all" }, confirmRemoval: false });
    await gotoAppShell(page);
    await openSkillsIntegrations(page);

    await openSkillSelection(page);
    await chooseCustomSkills(page, ["paseo", "paseo-advisor"]);
    await saveSkillSelection(page);

    await expectRemovalWarning(page, ["paseo-loop"]);
    await expectSkillSelectionOpen(page);
    await expectSkillsInstalled(skills, skills.bundledSkills);
    await expectSavedSkillSelection(skills, { mode: "all" });
  });

  test("confirming the warning removes the skill", async ({ page, startSkills }) => {
    const skills = await startSkills({ installed: { mode: "all" }, confirmRemoval: true });
    await gotoAppShell(page);
    await openSkillsIntegrations(page);

    await openSkillSelection(page);
    await chooseCustomSkills(page, ["paseo", "paseo-advisor"]);
    await saveSkillSelection(page);

    await expectRemovalWarning(page, ["paseo-loop"]);
    await expectSkillsInstalled(skills, ["paseo", "paseo-advisor"]);
    await expectSelectedSkills(page, ["paseo", "paseo-advisor"]);
  });

  test("warns for a skill installed in only one agent directory", async ({ page, startSkills }) => {
    const skills = await startSkills({
      installed: { mode: "all" },
      keepOnlyIn: { skill: "paseo-loop", target: "claude" },
      confirmRemoval: false,
    });
    await gotoAppShell(page);
    await openSkillsIntegrations(page);

    await openSkillSelection(page);
    await chooseCustomSkills(page, ["paseo", "paseo-advisor"]);
    await saveSkillSelection(page);

    await expectRemovalWarning(page, ["paseo-loop"]);
    await expectSkillSelectionOpen(page);
    await expectSkillPresentIn(skills, "claude", "paseo-loop");
    await expectSavedSkillSelection(skills, { mode: "all" });
  });

  test("warns for a skill on disk that the saved selection never mentioned", async ({
    page,
    startSkills,
  }) => {
    // The committed preference excludes paseo-loop, but the directory is back —
    // a manual reinstall or an external sync. Saving any edit deletes it.
    const skills = await startSkills({
      installed: { mode: "custom", skills: ["paseo"] },
      placeOnDisk: {
        skill: "paseo-loop",
        target: "claude",
        files: { "SKILL.md": "# paseo-loop\n", "notes/mine.md": "my notes" },
      },
      confirmRemoval: false,
    });
    await gotoAppShell(page);
    await openSkillsIntegrations(page);

    await openSkillSelection(page);
    await toggleSkill(page, "paseo-advisor");
    await saveSkillSelection(page);

    await expectRemovalWarning(page, ["paseo-loop"]);
    await expectSkillSelectionOpen(page);
    await expectSkillFilePresent(skills, "claude", "paseo-loop", "notes/mine.md");
    await expectSavedSkillSelection(skills, { mode: "custom", skills: ["paseo"] });
  });

  test("adding a skill saves without a warning", async ({ page, startSkills }) => {
    const skills = await startSkills({
      installed: { mode: "custom", skills: ["paseo"] },
      confirmRemoval: false,
    });
    await gotoAppShell(page);
    await openSkillsIntegrations(page);

    await openSkillSelection(page);
    await toggleSkill(page, "paseo-loop");
    await saveSkillSelection(page);

    await expectSkillsInstalled(skills, ["paseo", "paseo-loop"]);
    await expectNoRemovalWarning(page);
  });
});
