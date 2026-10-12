import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { gotoWorkspace } from "../support/helpers/launcher";
import { connectSeedClient } from "../support/helpers/seed-client";
import { openChangesTreePanel } from "../support/helpers/workspace-tabs";

test.skip(
  process.platform === "win32",
  "Windows does not preserve trailing spaces in folder names",
);

async function createProjectWithTrailingSpace() {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-project-path-spaces-"));
  const repoPath = path.join(root, "repo ");
  execFileSync("git", ["init", "-b", "main", repoPath], { stdio: "pipe" });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Paseo Test",
      "-c",
      "user.email=test@getpaseo.local",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-m",
      "initial",
    ],
    { cwd: repoPath, stdio: "pipe" },
  );
  await writeFile(path.join(repoPath, "visible-change.txt"), "a change\n");
  const client = await connectSeedClient();
  const added = await client.addProject(repoPath);
  expect(added.error).toBeNull();
  const created = await client.createWorkspace({
    source: { kind: "directory", path: repoPath, projectId: added.project!.projectId },
  });
  expect(created.error).toBeNull();
  return {
    workspaceId: created.workspace!.id,
    cleanup: async () => {
      await client.removeProject(added.project!.projectId);
      await client.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("Changes shows files in a project whose folder ends in a space", async ({
  page,
}, testInfo) => {
  const project = await createProjectWithTrailingSpace();
  try {
    await gotoWorkspace(page, project.workspaceId);
    await openChangesTreePanel(page);
    await page.screenshot({ path: testInfo.outputPath("changes-before-assertion.png") });
    await expect(page.getByText("visible-change.txt", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Not a git repository", { exact: true })).toHaveCount(0);
  } finally {
    await project.cleanup();
  }
});
