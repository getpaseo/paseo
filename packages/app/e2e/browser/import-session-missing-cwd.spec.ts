import { mkdtempSync } from "node:fs";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { ImportSessionFlow } from "../support/helpers/import-session";
import {
  connectNewWorkspaceDaemonClient,
  openProjectViaDaemon,
  type OpenedProject,
} from "../support/helpers/new-workspace";
import { createTempDirectory, type TempDirectory } from "../support/helpers/workspace";

const claudeConfigDirectory = mkdtempSync(path.join(tmpdir(), "paseo-import-missing-cwd-claude-"));

test.use({
  e2eDaemonConfig: {
    version: 1,
    agents: {
      providers: {
        codex: { enabled: false },
        copilot: { enabled: false },
        omp: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
      },
    },
  },
  e2eDaemonEnvironment: { CLAUDE_CONFIG_DIR: claudeConfigDirectory },
});

let client: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>;
let present: TempDirectory;
let project: OpenedProject;

test.setTimeout(120_000);

test.beforeAll(async () => {
  present = await createTempDirectory("imc-present-");
  const removed = await createTempDirectory("imc-removed-");
  client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  project = await openProjectViaDaemon(client, present.path);
  await seedClaudeSession({
    cwd: present.path,
    id: "present-session",
    title: "Session in a present folder",
  });
  await seedClaudeSession({
    cwd: removed.path,
    id: "removed-session",
    title: "Session in a removed folder",
  });
  await removed.cleanup();
});

test.afterAll(async () => {
  await client?.removeProject(project?.projectId).catch(() => undefined);
  await client?.close().catch(() => undefined);
  await present?.cleanup().catch(() => undefined);
  await rm(claudeConfigDirectory, { recursive: true, force: true });
});

test("a session whose folder was removed is listed but cannot be imported", async ({ page }) => {
  const flow = new ImportSessionFlow(page);
  await flow.openWorkspace(project.workspaceId, { width: 1280, height: 800 });
  await flow.openGlobally();

  const removedRow = page.getByTestId("import-session-session-claude-removed-session");
  await expect(removedRow).toBeVisible();
  await expect(removedRow).toHaveAttribute("aria-disabled", "true");
  await expect(
    page.getByTestId("import-session-row-cwd-missing-claude-removed-session"),
  ).toHaveText("Folder no longer exists");
  await expect(
    page.getByTestId("import-session-row-cwd-missing-claude-present-session"),
  ).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("import-sheet-missing-folder.png") });

  await removedRow.click({ force: true });
  await expect(page.getByText("Importing...", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Could not import selected session.", { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByTestId("import-session-sheet")).toBeVisible();

  await flow.importSession("present-session");
  await flow.expectTranscript("Prompt for present-session", "Answer for present-session");
});

async function seedClaudeSession(input: { cwd: string; id: string; title: string }) {
  const projectDirectory = path.join(
    claudeConfigDirectory,
    "projects",
    input.cwd.replace(/[^a-zA-Z0-9]/g, "-"),
  );
  await mkdir(projectDirectory, { recursive: true });
  const sessionPath = path.join(projectDirectory, `${input.id}.jsonl`);
  const records = [
    {
      type: "user",
      uuid: `${input.id}-user`,
      message: { role: "user", content: `Prompt for ${input.id}` },
      cwd: input.cwd,
      sessionId: input.id,
    },
    {
      type: "assistant",
      uuid: `${input.id}-assistant`,
      message: { role: "assistant", content: [{ type: "text", text: `Answer for ${input.id}` }] },
      cwd: input.cwd,
      sessionId: input.id,
    },
    { type: "custom-title", customTitle: input.title, sessionId: input.id },
  ];
  await writeFile(sessionPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  const timestamp = new Date(Date.now() - 60_000);
  await utimes(sessionPath, timestamp, timestamp);
}
