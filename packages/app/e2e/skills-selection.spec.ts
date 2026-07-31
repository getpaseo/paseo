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
  expectSaveErrorKeepsSheetOpen,
  expectSelectedSkills,
  expectSkillsInstalled,
  openSkillsIntegrations,
  openSkillSelection,
  saveSkillSelection,
  toggleSkill,
  serveRealSkillsCommands,
  type SkillsSandbox,
} from "./helpers/skills-selection";

// Every skills command runs against the real desktop handlers over a temp bundle
// and temp user data, so the assertions cover persistence and convergence, not a
// browser stand-in for them.
const test = base.extend<{ skills: SkillsSandbox; brokenSkills: SkillsSandbox }>({
  skills: async ({ page }, provide) => {
    const sandbox = await createSkillsSandbox();
    await injectDesktopBridge(page, { serverId: getServerId() });
    await serveRealSkillsCommands(page, sandbox);
    await provide(sandbox);
    await sandbox.cleanup();
  },
  brokenSkills: async ({ page }, provide) => {
    const sandbox = await createSkillsSandbox({ blockAgentsDir: true });
    await injectDesktopBridge(page, { serverId: getServerId() });
    await serveRealSkillsCommands(page, sandbox);
    await provide(sandbox);
    await sandbox.cleanup();
  },
});

test.describe("Choosing installed skills", () => {
  test("installs only the skills selected in Settings", async ({ page, skills }) => {
    await gotoAppShell(page);
    await openSkillsIntegrations(page);

    await openSkillSelection(page);
    await chooseCustomSkills(page, ["paseo", "paseo-loop"]);
    await saveSkillSelection(page);

    await expectSkillsInstalled(skills, ["paseo", "paseo-loop"]);
    await expectSelectedSkills(page, ["paseo", "paseo-loop"]);
  });

  test("all skills includes every available skill", async ({ page, skills }) => {
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

  test("cancelling leaves the installed skills untouched", async ({ page, skills }) => {
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

  test("a failed save keeps the sheet open with an error", async ({ page, brokenSkills }) => {
    await gotoAppShell(page);
    await openSkillsIntegrations(page);

    await openSkillSelection(page);
    await chooseCustomSkills(page, ["paseo"]);
    await saveSkillSelection(page);

    await expectSaveErrorKeepsSheetOpen(page);
    await expectSkillsInstalled(brokenSkills, []);
  });
});
