import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type Page } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

async function readFileLinkTooltip(page: Page): Promise<void> {
  const link = page.getByRole("link", { name: "the guide", exact: true });
  await link.hover();
  await expect(page.getByRole("tooltip")).toContainText("guide.md");
}

async function leaveFileLink(page: Page): Promise<void> {
  await page.mouse.move(5, 5);
  await expect(page.getByRole("tooltip")).toHaveCount(0);
}

async function openLinkedFile(page: Page): Promise<void> {
  await page.getByRole("link", { name: "the guide", exact: true }).click();
  await expect(page.getByTestId("markdown-preview-frame")).toContainText("Example guide");
  await leaveFileLink(page);
}

async function returnToAgent(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Tooltip regression", exact: true }).click();
  await expect(page.getByRole("link", { name: "the guide", exact: true })).toBeVisible();
  await leaveFileLink(page);
}

async function switchToFileTab(page: Page): Promise<void> {
  await page.getByRole("button", { name: "guide.md", exact: true }).click();
  await expect(page.getByTestId("markdown-preview-frame")).toContainText("Example guide");
  await leaveFileLink(page);
}

test("opening an assistant file link dismisses its tooltip over the file tab", async ({
  page,
}, testInfo) => {
  testInfo.setTimeout(120_000);
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "tooltip-5811-",
    title: "Tooltip regression",
    featureValues: {
      mockStreamingAssistantResponse: "Read [the guide](./guide.md).",
      mockStreamingAssistantIntervalMs: 5,
    },
  });
  try {
    await writeFile(
      path.join(agent.cwd, "guide.md"),
      "# Example guide\n\n" + "Plain paragraph.\n\n".repeat(150),
    );
    await openAgentRoute(page, agent);
    await agent.client.sendAgentMessage(agent.agentId, "Show the file link.");
    await agent.client.waitForFinish(agent.agentId, 30_000);

    await readFileLinkTooltip(page);
    await leaveFileLink(page);
    await readFileLinkTooltip(page);
    await openLinkedFile(page);
    await returnToAgent(page);
    await readFileLinkTooltip(page);
    await switchToFileTab(page);
    await returnToAgent(page);
    await readFileLinkTooltip(page);
    await leaveFileLink(page);
  } finally {
    await agent.cleanup();
  }
});

async function readLinkedGuide(page: Page, linkName: string, content: string): Promise<void> {
  await page.getByRole("link", { name: linkName, exact: true }).click();
  await expect(page.getByTestId("markdown-preview-frame").filter({ visible: true })).toContainText(
    content,
  );
}

async function returnToNestedLinks(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Nested file links", exact: true }).click();
  await expect(page.getByRole("link", { name: "nested guide", exact: true })).toBeVisible();
}

test("assistant directory paths find nested files and preserve exact workspace paths", async ({
  page,
}, testInfo) => {
  testInfo.setTimeout(120_000);
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "nested-file-link-",
    title: "Nested file links",
    featureValues: {
      mockStreamingAssistantResponse:
        "Read [nested guide](schema/x.md), [exact guide](schema/exact.md), and [missing guide](schema/missing.md).",
      mockStreamingAssistantIntervalMs: 5,
    },
  });
  try {
    await mkdir(path.join(agent.cwd, "repo-a/schema"), { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: path.join(agent.cwd, "repo-a") });
    await writeFile(
      path.join(agent.cwd, "repo-a/schema/x.md"),
      "# Nested file content\n\nDetails\n",
    );
    await mkdir(path.join(agent.cwd, "schema"), { recursive: true });
    await writeFile(path.join(agent.cwd, "schema/exact.md"), "# Exact file content\n");
    await writeFile(path.join(agent.cwd, "repo-a/schema/exact.md"), "# Wrong nested content\n");
    await openAgentRoute(page, agent);
    await agent.client.sendAgentMessage(agent.agentId, "Show the file links.");
    await agent.client.waitForFinish(agent.agentId, 30_000);

    await expect(page.getByRole("textbox", { name: "Message agent..." }).first()).toBeEnabled();
    await readLinkedGuide(page, "nested guide", "Nested file content");
    await returnToNestedLinks(page);
    await readLinkedGuide(page, "exact guide", "Exact file content");
    await returnToNestedLinks(page);
    await page.getByRole("link", { name: "missing guide", exact: true }).click();
    await expect(page.getByText("File not found", { exact: true })).toBeVisible();
  } finally {
    await agent.cleanup();
  }
});

const sshAliasTest = test.extend({
  e2eDaemonEnvironment: [
    async ({ browserName: _browserName }, provide) => {
      const directory = await mkdtemp(path.join(tmpdir(), "paseo-forge-ssh-"));
      const locator = process.platform === "win32" ? "where.exe" : "which";
      const sshPath = execFileSync(locator, ["ssh"], { encoding: "utf8" })
        .trim()
        .split(/\r?\n/u)[0];
      const configPath = path.join(directory, "config");
      await writeFile(configPath, "Host github.com-work\n  HostName github.com\n");
      const sshSource = `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const result = spawnSync(${JSON.stringify(sshPath)}, ["-F", ${JSON.stringify(configPath)}, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(result.status ?? 1);
`;
      try {
        for (const [command, source] of [
          ["ssh", sshSource],
          // Rendering a reference needs no network access to the forge CLI.
          ["gh", "#!/usr/bin/env node\nprocess.exit(1);\n"],
        ]) {
          const commandPath = path.join(directory, command);
          await writeFile(commandPath, source);
          await chmod(commandPath, 0o755);
          if (process.platform === "win32") {
            await writeFile(`${commandPath}.cmd`, `@node "%~dp0${command}" %*\r\n`);
          }
        }
        await provide({ PATH: `${directory}${path.delimiter}${process.env.PATH ?? ""}` });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    { scope: "worker" },
  ],
});

sshAliasTest(
  "assistant issue links resolve SSH aliases in their destination and tooltip",
  async ({ page }, testInfo) => {
    testInfo.setTimeout(120_000);
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "forge-ssh-alias-",
      repo: { originUrl: "git@github.com-work:acme/repo.git" },
      title: "SSH alias references",
      featureValues: {
        mockStreamingAssistantResponse: "PR #1 is ready. Related: other/tools#2.",
        mockStreamingAssistantIntervalMs: 5,
      },
    });
    try {
      await openAgentRoute(page, agent);
      await agent.client.sendAgentMessage(agent.agentId, "Show the issue links.");
      await agent.client.waitForFinish(agent.agentId, 30_000);

      const link = page.getByRole("link", { name: "#1", exact: true });
      await link.hover();
      await expect(page.getByRole("tooltip")).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("forge-reference-hover.png") });
      await expect(link).toHaveAttribute("href", "https://github.com/acme/repo/issues/1");
      await expect(page.getByRole("tooltip")).toHaveText("https://github.com/acme/repo/issues/1");
      await expect(page.getByRole("link", { name: "other/tools#2", exact: true })).toHaveAttribute(
        "href",
        "https://github.com/other/tools/issues/2",
      );

      await page.reload();
      await expect(page.getByRole("link", { name: "#1", exact: true })).toHaveAttribute(
        "href",
        "https://github.com/acme/repo/issues/1",
      );
    } finally {
      await agent.cleanup();
    }
  },
);
