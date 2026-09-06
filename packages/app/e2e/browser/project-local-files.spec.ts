import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test as base, expect } from "../support/fixtures";
import { seedWorkspace } from "../support/helpers/seed-client";
import { openProjectSettings, openProjects } from "../support/helpers/project-settings";
import { gotoAppShell } from "../support/helpers/app";
import {
  openNewWorkspaceComposer,
  selectWorkspaceIsolation,
} from "../support/helpers/new-workspace";
import type { Page } from "@playwright/test";

interface ProjectFixture {
  name: string;
  root: string;
  projectKey: string;
  projectId: string;
}
const test = base.extend<{ localFilesProject: ProjectFixture }>({
  localFilesProject: async ({ page }, provide) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const workspace = await seedWorkspace({
      repoPrefix: "local-files-ui-",
      repo: {
        paseoConfig: {
          worktree: { setup: "echo setup" },
          metadataGeneration: { branchName: { instructions: "preserve me" } },
        },
        files: [{ path: ".gitignore", content: ".env*\nlocal/\n" }],
      },
    });
    await writeFile(path.join(workspace.repoPath, ".env"), "original");
    try {
      await provide({
        name: workspace.projectDisplayName,
        root: workspace.repoPath,
        projectKey: workspace.projectKey,
        projectId: workspace.projectId,
      });
      expect(pageErrors).toEqual([]);
    } finally {
      await workspace.cleanup();
    }
  },
});

async function pickFiles(page: Page, files: { name: string; value: string }[]) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("local-files-device").click();
  await (
    await chooser
  ).setFiles(
    files.map((file) => ({
      name: file.name,
      mimeType: "application/octet-stream",
      buffer: Buffer.from(file.value),
    })),
  );
}

test("previews files without values, requires explicit replacement, imports, and remembers inclusion", async ({
  page,
  localFilesProject,
}, testInfo) => {
  await openProjects(page);
  await openProjectSettings(page, localFilesProject.name);
  await page.getByTestId("local-files-open").click();
  await expect(page.getByTestId("local-files-sheet")).toContainText(localFilesProject.root);
  await pickFiles(page, [
    { name: ".env.local", value: "FIXTURE_ONLY=local-value" },
    { name: ".env", value: "replacement" },
    { name: "README.md", value: "must not replace a tracked file" },
  ]);
  await expect(page.getByTestId("local-file-select-.env.local")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page.getByTestId("local-file-select-.env")).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("local-file-select-README.md")).toBeDisabled();
  await expect(page.getByText("FIXTURE_ONLY=local-value", { exact: false })).toHaveCount(0);
  await expect(page.getByTestId("local-files-config-preview")).toContainText(".env.local");
  await page.screenshot({
    path: testInfo.outputPath("import-preview-desktop.png"),
    fullPage: true,
  });
  await page.getByTestId("local-files-submit").click();
  await expect(page.getByTestId("local-files-complete")).toBeVisible();
  expect(await readFile(path.join(localFilesProject.root, ".env.local"), "utf8")).toBe(
    "FIXTURE_ONLY=local-value",
  );
  expect(await readFile(path.join(localFilesProject.root, ".env"), "utf8")).toBe("original");
  const config = JSON.parse(
    await readFile(path.join(localFilesProject.root, "paseo.json"), "utf8"),
  );
  expect(config.worktree).toEqual({ setup: "echo setup", localFiles: [".env.local"] });
  expect(config.metadataGeneration.branchName.instructions).toBe("preserve me");
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
    "FIXTURE_ONLY=local-value",
  );
  await page
    .getByTestId("local-files-sheet")
    .getByRole("button", { name: "Close", exact: true })
    .last()
    .click();
  await expect(page.getByTestId("local-files-sheet")).toHaveCount(0);
});

test("refreshes a conflicting config and saves inclusion without reimporting bytes", async ({
  page,
  localFilesProject,
}) => {
  let imports = 0;
  page.on("websocket", (socket) =>
    socket.on("framesent", ({ payload }) => {
      if (typeof payload !== "string") return;
      const frame = JSON.parse(payload);
      if (frame.message?.type === "project.local_files.import.request") imports++;
    }),
  );
  await openProjects(page);
  await openProjectSettings(page, localFilesProject.name);
  await page.getByTestId("local-files-open").click();
  await pickFiles(page, [{ name: ".env.local", value: "config-retry-fixture" }]);
  await expect(page.getByTestId("local-files-submit")).toBeEnabled();
  await writeFile(
    path.join(localFilesProject.root, "paseo.json"),
    JSON.stringify({
      worktree: { setup: "echo externally updated" },
      retained: "external-config",
    }),
  );
  await page.getByTestId("local-files-submit").click();
  await expect(page.getByTestId("local-files-refresh-config")).toBeVisible();
  expect(imports).toBe(1);
  expect(await readFile(path.join(localFilesProject.root, ".env.local"), "utf8")).toBe(
    "config-retry-fixture",
  );
  await page.getByTestId("local-files-refresh-config").click();
  await expect(page.getByTestId("local-files-submit")).toBeEnabled();
  await page.getByTestId("local-files-submit").click();
  await expect(page.getByTestId("local-files-complete")).toBeVisible();
  expect(imports).toBe(1);
  const config = JSON.parse(
    await readFile(path.join(localFilesProject.root, "paseo.json"), "utf8"),
  );
  expect(config.retained).toBe("external-config");
  expect(config.worktree).toEqual({ setup: "echo externally updated", localFiles: [".env.local"] });
});

test("rejects a stale destination and lets the user review a fresh replacement", async ({
  page,
  localFilesProject,
}) => {
  await openProjects(page);
  await openProjectSettings(page, localFilesProject.name);
  await page.getByTestId("local-files-open").click();
  await pickFiles(page, [{ name: ".env", value: "chosen replacement" }]);
  await page.getByTestId("local-file-select-.env").click();
  await page.getByTestId("local-files-include").click();
  await writeFile(path.join(localFilesProject.root, ".env"), "external update");
  await page.getByTestId("local-files-submit").click();
  await expect(page.getByTestId("local-files-error")).toBeVisible();
  expect(await readFile(path.join(localFilesProject.root, ".env"), "utf8")).toBe("external update");
  await pickFiles(page, [{ name: ".env", value: "chosen replacement" }]);
  await expect(page.getByTestId("local-file-select-.env")).toHaveAttribute("aria-checked", "false");
  await page.getByTestId("local-file-select-.env").click();
  await page.getByTestId("local-files-submit").click();
  await expect(page.getByTestId("local-files-complete")).toBeVisible();
  expect(await readFile(path.join(localFilesProject.root, ".env"), "utf8")).toBe(
    "chosen replacement",
  );
});

test("imports in a compact viewport with the action visible and large files unselected", async ({
  page,
  localFilesProject,
}, testInfo) => {
  await openProjects(page);
  await openProjectSettings(page, localFilesProject.name);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId("local-files-open").click();
  await pickFiles(page, [
    { name: ".env.local", value: "compact-fixture" },
    { name: ".env.large", value: "x".repeat(2 * 1024 * 1024) },
  ]);
  await expect(page.getByTestId("local-file-select-.env.large")).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await expect(page.getByTestId("local-files-submit")).toBeInViewport();
  await expect(page.getByTestId("local-files-include")).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath("import-preview-compact.png"),
    fullPage: true,
  });
  await page.getByTestId("local-files-submit").click();
  await expect(page.getByTestId("local-files-complete")).toBeVisible();
  expect(await readFile(path.join(localFilesProject.root, ".env.local"), "utf8")).toBe(
    "compact-fixture",
  );
});

test("copies a reviewed file from another connected project", async ({
  page,
  localFilesProject,
}) => {
  const source = await seedWorkspace({
    repoPrefix: "local-files-source-",
    repo: {
      files: [{ path: ".gitignore", content: ".env*\n" }],
    },
  });
  try {
    await writeFile(path.join(source.repoPath, ".env.local"), "host-source-fixture");
    await openProjects(page);
    await openProjectSettings(page, localFilesProject.name);
    await page.getByTestId("local-files-open").click();
    await page.getByRole("button", { name: "From another host…", exact: true }).click();
    await page.getByRole("menuitem").filter({ hasText: source.repoPath }).click();
    await expect(page.getByTestId("local-file-select-.env.local")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await page.getByTestId("local-files-submit").click();
    await expect(page.getByTestId("local-files-complete")).toBeVisible();
    expect(await readFile(path.join(localFilesProject.root, ".env.local"), "utf8")).toBe(
      "host-source-fixture",
    );
  } finally {
    await source.cleanup();
  }
});

test("shows missing configured files at creation and requires an explicit choice to continue", async ({
  page,
  localFilesProject,
  e2eWorkerClient,
}, testInfo) => {
  await writeFile(
    path.join(localFilesProject.root, "paseo.json"),
    JSON.stringify({ worktree: { localFiles: [".env.missing"] } }),
  );
  await gotoAppShell(page);
  await openNewWorkspaceComposer(page, {
    projectKey: localFilesProject.projectKey,
    projectDisplayName: localFilesProject.name,
  });
  await selectWorkspaceIsolation(page, "worktree");
  await expect(page.getByText("Missing local files", { exact: true })).toBeVisible();
  await expect(page.getByTestId("local-files-open")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("creation-missing-files.png"),
    fullPage: true,
  });
  const before = (await e2eWorkerClient.fetchWorkspaces()).entries.length;
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain(".env.missing");
    await dialog.dismiss();
  });
  await page
    .getByTestId("message-input-root")
    .getByRole("button", { name: "Create", exact: true })
    .click();
  await expect(
    page.getByTestId("message-input-root").getByRole("button", { name: "Create", exact: true }),
  ).toBeEnabled();
  await expect(page).toHaveURL(/\/new(?:\?|$)/);
  await expect(page.getByTestId("app-toast-message")).toHaveCount(0);
  expect((await e2eWorkerClient.fetchWorkspaces()).entries).toHaveLength(before);
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByTestId("message-input-root")
    .getByRole("button", { name: "Create", exact: true })
    .click();
  await expect(page).toHaveURL(/\/workspace\//);
  await expect
    .poll(async () => (await e2eWorkerClient.fetchWorkspaces()).entries.length)
    .toBe(before + 1);
});

test("asks to update an older host without sending unsupported local-file RPCs", async ({
  page,
  localFilesProject,
}) => {
  const localFileRequests: string[] = [];
  await page.routeWebSocket(daemonWsRoutePattern(), (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      if (typeof message === "string") {
        const frame = JSON.parse(message);
        const type = frame.message?.type;
        if (typeof type === "string" && type.startsWith("project.local_files."))
          localFileRequests.push(type);
      }
      server.send(message);
    });
    server.onMessage((message) => {
      if (typeof message !== "string") {
        socket.send(message);
        return;
      }
      const frame = JSON.parse(message);
      const payload = frame.message?.payload ?? frame.payload;
      if (payload?.status === "server_info" && payload.features)
        delete payload.features.projectLocalFiles;
      socket.send(JSON.stringify(frame));
    });
  });
  await openProjects(page);
  await openProjectSettings(page, localFilesProject.name);
  await expect(
    page.getByText("Update this host to import local files.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("local-files-open")).toHaveCount(0);
  expect(localFileRequests).toEqual([]);
});
