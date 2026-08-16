import { access } from "node:fs/promises";
import { expect, test as base } from "../support/fixtures";
import {
  answerNextRemovalWarning,
  cancelSkillSelection,
  chooseAllSkills,
  chooseCustomSkills,
  expectInstalledSkills,
  expectSavedSelection,
  expectSkillFile,
  openAgentSkillsSettings,
  openSkillSelection,
  saveSkillSelection,
  startAgentSkillsSandbox,
  toggleSkill,
  type AgentSkillsSandbox,
} from "../support/helpers/agent-skills";
import { readVerticalGap, waitForSettledPosition } from "../support/helpers/sheet-layout";

const test = base.extend<{ skills: AgentSkillsSandbox }>({
  skills: async (_fixtures, provide) => {
    const sandbox = await startAgentSkillsSandbox();
    try {
      await provide(sandbox);
    } finally {
      await sandbox.close();
    }
  },
});

test.describe("Host agent skills", () => {
  test.describe.configure({ timeout: 120_000 });

  test("installs a custom selection, cancels a draft, then installs all skills", async ({
    page,
    skills,
  }) => {
    const custom = skills.available.slice(0, 2);
    const cancelledAddition = skills.available[2]!;
    await openAgentSkillsSettings(page, skills);

    await openSkillSelection(page);
    await chooseCustomSkills(page, custom);
    await saveSkillSelection(page);
    await expectInstalledSkills(skills, custom);
    await expectSavedSelection(skills, { mode: "custom", skills: custom });

    await openSkillSelection(page);
    await toggleSkill(page, cancelledAddition);
    await cancelSkillSelection(page);
    await expectInstalledSkills(skills, custom);
    await expectSavedSelection(skills, { mode: "custom", skills: custom });

    await openSkillSelection(page);
    await chooseAllSkills(page);
    await saveSkillSelection(page);
    await expectSavedSelection(skills, { mode: "all" });
    await expectInstalledSkills(skills, skills.available);
  });

  test("dismisses and then accepts removal confirmation", async ({ page, skills }) => {
    const retained = skills.available.slice(0, 2);
    const removed = skills.available.slice(2);
    await skills.install({ mode: "all" });
    await openAgentSkillsSettings(page, skills);
    await openSkillSelection(page);
    await chooseCustomSkills(page, retained);

    const dismissedWarning = answerNextRemovalWarning(page, "dismiss");
    await saveSkillSelection(page);
    const dismissedDialog = await dismissedWarning;
    expect(dismissedDialog.message()).toContain("Remove deselected skills?");
    for (const skill of removed) expect(dismissedDialog.message()).toContain(skill);
    await expectInstalledSkills(skills, skills.available);
    await expectSavedSelection(skills, { mode: "all" });

    const acceptedWarning = answerNextRemovalWarning(page, "accept");
    await saveSkillSelection(page);
    expect((await acceptedWarning).message()).toContain(
      "Anything you added inside those skill folders",
    );
    await expectInstalledSkills(skills, retained);
    await expectSavedSelection(skills, { mode: "custom", skills: retained });
  });

  test("warns before removing a partial installation", async ({ page, skills }) => {
    const partial = skills.available.at(-1)!;
    const retained = skills.available.filter((name) => name !== partial);
    await skills.install({ mode: "all" });
    await skills.keepSkillOnlyIn(partial, "claude");
    await openAgentSkillsSettings(page, skills);
    await openSkillSelection(page);
    await chooseCustomSkills(page, retained);

    const warning = answerNextRemovalWarning(page, "dismiss");
    await saveSkillSelection(page);
    expect((await warning).message()).toContain(partial);
    await expectSkillFile(skills, "claude", partial, "SKILL.md");
    await expectSavedSelection(skills, { mode: "all" });
  });

  test("warns without deleting user files from an externally restored skill", async ({
    page,
    skills,
  }) => {
    const retained = skills.available.slice(0, 2);
    const drift = skills.available[2]!;
    await skills.install({ mode: "custom", skills: retained });
    await skills.placeSkillOnDisk(drift, "claude", {
      "SKILL.md": `# ${drift}\n`,
      "notes/mine.md": "user notes",
    });
    await openAgentSkillsSettings(page, skills);
    await openSkillSelection(page);

    const warning = answerNextRemovalWarning(page, "dismiss");
    await saveSkillSelection(page);
    expect((await warning).message()).toContain(drift);
    await expectSkillFile(skills, "claude", drift, "notes/mine.md");
    await expectSavedSelection(skills, { mode: "custom", skills: retained });
  });

  test("keeps the sheet open with an error when convergence fails", async ({ page, skills }) => {
    await openAgentSkillsSettings(page, skills);
    await openSkillSelection(page);
    await skills.blockAgentsDirectory();
    await chooseCustomSkills(page, [skills.available[0]!]);
    await saveSkillSelection(page);

    await expect(
      page.getByText("Could not save your skill selection.", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("switch", { name: "All skills", exact: true })).toBeVisible();
    await skills.unblockAgentsDirectory();
    await expectSavedSelection(skills, { mode: "all" });
  });

  test("serializes concurrent saves through the daemon command surface", async ({ skills }) => {
    const firstSelection = { mode: "custom" as const, skills: [skills.available[0]!] };
    const secondSelection = { mode: "custom" as const, skills: [skills.available[1]!] };

    const first = skills.client.saveAgentSkillsSelection(firstSelection, skills.available);
    const second = skills.client.saveAgentSkillsSelection(secondSelection, skills.available);
    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { confirmationRequired: null, selection: firstSelection },
      { confirmationRequired: null, selection: secondSelection },
    ]);

    await expectInstalledSkills(skills, secondSelection.skills);
    await expectSavedSelection(skills, secondSelection);
  });

  test("ignores agent config environment overrides", async ({ skills }) => {
    await skills.install({ mode: "custom", skills: [skills.available[0]!] });

    await expect(
      access(`${skills.home}/../ignored-claude-config/skills`).then(
        () => true,
        () => false,
      ),
    ).resolves.toBe(false);
    await expect(
      access(`${skills.home}/../ignored-codex-home/skills`).then(
        () => true,
        () => false,
      ),
    ).resolves.toBe(false);
  });
});

function allSkillsCard(page: Parameters<typeof openSkillSelection>[0]) {
  return page.getByTestId("skill-selection-all-card");
}

function skillListCard(page: Parameters<typeof openSkillSelection>[0]) {
  return page.getByTestId("skill-selection-list-card");
}

function bundledSkillsLabel(page: Parameters<typeof openSkillSelection>[0]) {
  return page.getByText("Bundled skills", { exact: true });
}

test.describe("Agent skills sheet inset", () => {
  test.describe.configure({ timeout: 120_000 });

  test.describe("compact", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("keeps more space above the bundled skills label than below", async ({ page, skills }) => {
      await openAgentSkillsSettings(page, skills, { compact: true });
      await openSkillSelection(page);
      await waitForSettledPosition(page.getByTestId("skill-selection-sheet"));

      expect({
        aboveLabel: await readVerticalGap(allSkillsCard(page), bundledSkillsLabel(page)),
        belowLabel: await readVerticalGap(bundledSkillsLabel(page), skillListCard(page)),
      }).toEqual({ aboveLabel: 16, belowLabel: 12 });
    });
  });

  test.describe("desktop", () => {
    test.use({ viewport: { width: 1280, height: 900 } });

    test("keeps more space above the bundled skills label than below", async ({ page, skills }) => {
      await openAgentSkillsSettings(page, skills);
      await openSkillSelection(page);

      expect({
        aboveLabel: await readVerticalGap(allSkillsCard(page), bundledSkillsLabel(page)),
        belowLabel: await readVerticalGap(bundledSkillsLabel(page), skillListCard(page)),
      }).toEqual({ aboveLabel: 16, belowLabel: 12 });
    });
  });
});
