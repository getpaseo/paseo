import { mkdtemp, rm, symlink } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { test as base, expect } from "../support/fixtures";
import { prepareContentSearch } from "../support/helpers/workspace-content-search";

// The missing-rg fixture builds a PATH from `which` and POSIX symlinks. Windows needs its own
// PATH construction, which belongs to the CI gate rather than to this journey.
base.skip(process.platform === "win32", "the missing-ripgrep PATH fixture is POSIX-shaped");

const test = base.extend<{}, { searchHostPath: string }>({
  searchHostPath: [
    async ({ browserName }, provide) => {
      void browserName;
      const bin = await mkdtemp(path.join(os.tmpdir(), "search-host-path-"));
      await symlink(
        execFileSync("which", ["git"], { encoding: "utf8" }).trim(),
        path.join(bin, "git"),
      );
      await symlink(process.execPath, path.join(bin, "node"));
      try {
        await provide(bin);
      } finally {
        await rm(bin, { recursive: true, force: true });
      }
    },
    { scope: "worker" },
  ],
  e2eDaemonEnvironment: [
    async ({ searchHostPath }, provide) => {
      await provide({ PATH: searchHostPath });
    },
    { scope: "worker" },
  ],
});

test("missing host ripgrep is actionable and Retry works after installation", async ({
  page,
  withWorkspace,
  searchHostPath,
}, testInfo) => {
  const workspace = await withWorkspace();
  await prepareContentSearch(workspace);
  await page.keyboard.press("Control+Shift+F");
  await page
    .getByRole("textbox", { name: "Search saved file contents...", exact: true })
    .fill("needle");
  await expect(
    page.getByText("Install ripgrep on this host and make rg available on its PATH, then retry", {
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByTestId("command-center-panel")
    .screenshot({ path: testInfo.outputPath("missing-rg.png") });
  await symlink(
    execFileSync("which", ["rg"], { encoding: "utf8" }).trim(),
    path.join(searchHostPath, "rg"),
  );
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("button", { name: /search-a.ts:1:26/ })).toBeVisible();
});
