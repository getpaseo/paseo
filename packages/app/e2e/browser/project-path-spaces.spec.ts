import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test as base } from "../support/fixtures";
import { gotoWorkspace } from "../support/helpers/launcher";
import { openChangesTreePanel } from "../support/helpers/workspace-tabs";

const test = base.extend<{ projectWithTrailingSpace: string }>({
  projectWithTrailingSpace: async ({ e2eWorkerClient: client }, provide) => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-project-path-spaces-"));
    try {
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
      const added = await client.addProject(repoPath);
      expect(added.error).toBeNull();
      const projectId = added.project!.projectId;
      try {
        const created = await client.createWorkspace({
          source: { kind: "directory", path: repoPath, projectId },
        });
        expect(created.error).toBeNull();
        await provide(created.workspace!.id);
      } finally {
        await client.removeProject(projectId);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
});

test.skip(
  process.platform === "win32",
  "Windows does not preserve trailing spaces in folder names",
);

test("Changes shows files in a project whose folder ends in a space", async ({
  page,
  projectWithTrailingSpace,
}, testInfo) => {
  await gotoWorkspace(page, projectWithTrailingSpace);
  await openChangesTreePanel(page);
  await expect(page.getByText("visible-change.txt", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Not a git repository", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("changes.png") });
});
