import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { waitForPermissionPrompt } from "../support/helpers/permissions";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

// Literal shell commands and copyright markers must survive Markdown rendering.
test.describe("Plan card markdown", () => {
  test("renders plan text verbatim", async ({ page }) => {
    test.setTimeout(180_000);

    const session = await seedMockAgentWorkspace({
      repoPrefix: "plan-card-markdown-",
      title: "Plan card markdown e2e",
      initialPrompt: "Emit synthetic plan approval.",
    });

    try {
      await openAgentRoute(page, session);
      await waitForPermissionPrompt(page, 120_000);

      const planCard = page.getByTestId("permission-plan-card");
      await expect(planCard.locator(".enrm-text")).toBeVisible();
      await expect(planCard).toContainText("(c)");
      await expect(planCard).toContainText('--name="my repo"');
      await expect(planCard).toContainText("---buzz");
      await expect(planCard).not.toContainText("©");
      await expect(planCard).not.toContainText("—buzz");
    } finally {
      await session.cleanup();
    }
  });
});

test("chat and file preview share the library renderer and resolve file links", async ({
  page,
}, testInfo) => {
  await withSharedMarkdownFiles(page, async () => {
    const message = page.getByTestId("assistant-message");
    await expect(message).toHaveCount(1);
    await expect(message.locator(".enrm-text > p").first()).toContainText("First paragraph.");
    await expect(message.locator(".enrm-text > p").nth(1)).toContainText("Second paragraph.");
    await expect(message.locator("blockquote")).toContainText("A quote");
    await expect(message.getByRole("table")).toContainText("42");
    await expect(message.getByRole("cell").nth(0)).toHaveText("Answer");
    await expect(message.getByRole("cell").nth(1)).toHaveText("");
    await expect(message.getByRole("cell").nth(2)).toHaveText("42");
    await expect(message.locator("p div")).toHaveCount(0);
    await openSharedMarkdownFile(page, "README.md");
    const preview = page.getByTestId("markdown-preview-frame");
    await expect(preview.locator(".enrm-text")).toContainText("Second paragraph.");
    await expect(preview.getByRole("table")).toContainText("42");
    await returnToSharedMarkdownChat(page);
    await expectFileLinkTooltip(
      page,
      message.getByRole("link", { name: "src/说明.md:2-3", exact: true }),
      "packages/app/src/说明.md:2-3",
    );
    await openSharedMarkdownFile(page, "src/说明.md:2-3");
    await expect(page.getByText("Unicode suffix lookup succeeded.", { exact: true })).toBeVisible();
    await openSharedMarkdownFile(page, "packages/app/src/说明.md:2-3");
    await expect(page.getByText("Unicode suffix lookup succeeded.", { exact: true })).toBeVisible();
    await openSharedMarkdownFile(page, "Space file");
    await expect(
      page.getByText("Explicit link opened the space filename.", { exact: true }),
    ).toBeVisible();
    await openSharedMarkdownFile(page, "my%20file.ts");
    await expect(
      page.getByText("Inline code opened the literal percent filename.", { exact: true }),
    ).toBeVisible();
    await testInfo.attach("shared-renderer", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  });
});
async function expectFileLinkTooltip(page: Page, link: Locator, path: string) {
  await link.hover();
  await expect(page.getByRole("tooltip")).toHaveText(path);
}

async function withSharedMarkdownFiles(page: Page, run: () => Promise<void>) {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const source =
    "First paragraph.\n\nSecond paragraph.\n\n```ts\nconst answer = 42;\n```\n\n> A quote\n\n| Key || Value |\n| --- | --- | --- |\n| Answer || 42 |\n\nOpen `README.md` or `src/说明.md:2-3`, or packages/app/src/说明.md:2-3.\n\n[Space file](my%20file.ts) and `my%20file.ts`.";
  const session = await seedMockAgentWorkspace({
    repoPrefix: "shared-markdown-",
    title: "Shared Markdown",
    featureValues: { mockAssistantResponse: source },
    initialPrompt: "Show Markdown",
  });
  try {
    await writeFile(`${session.cwd}/README.md`, source);
    await writeFile(`${session.cwd}/my file.ts`, "Explicit link opened the space filename.");
    await writeFile(
      `${session.cwd}/my%20file.ts`,
      "Inline code opened the literal percent filename.",
    );
    await mkdir(`${session.cwd}/packages/app/src`, { recursive: true });
    await writeFile(
      `${session.cwd}/packages/app/src/说明.md`,
      "# Nested file\n\nUnicode suffix lookup succeeded.",
    );
    await session.client.waitForFinish(session.agentId, 30_000);
    // A cold render must work even when a separate parser chunk cannot be fetched.
    await page.route("**/wasm/md4c.bundle?**", (route) => route.abort("failed"));
    await openAgentRoute(page, session);
    await run();
  } finally {
    await session.cleanup();
  }
}

async function returnToSharedMarkdownChat(page: Page) {
  await page.getByRole("button", { name: "Shared Markdown", exact: true }).click();
}

async function openSharedMarkdownFile(page: Page, name: string) {
  await returnToSharedMarkdownChat(page);
  await page.getByTestId("assistant-message").getByRole("link", { name, exact: true }).click();
}

test("linked inline code keeps code typography and wraps long paths", async ({
  page,
}, testInfo) => {
  const longPath =
    "packages/app/src/components/markdown/renderer/very-long-directory-name/another-long-directory-name/file.ts:12";
  const session = await seedMockAgentWorkspace({
    repoPrefix: "inline-code-style-",
    title: "Inline code style",
    featureValues: {
      mockAssistantResponse:
        "Compare `ordinary_token`, `file.ts:12`, `https://example.com`. At the end of this line open `" +
        longPath +
        "`.",
    },
    initialPrompt: "Show inline code",
  });
  try {
    await session.client.waitForFinish(session.agentId, 30_000);
    await openAgentRoute(page, session);
    const message = page.getByTestId("assistant-message");
    await expect(message.getByRole("link", { name: longPath, exact: true })).toBeVisible();
    const measurements = await measureInlineCode(message);
    await testInfo.attach("inline-code-measurements", {
      body: JSON.stringify(measurements, null, 2),
      contentType: "application/json",
    });
    expect(measurements.codes).toHaveLength(4);
    const [plain, file, url, long] = measurements.codes;
    for (const linked of [file, url, long]) {
      expect(linked.fontSize).toBe(plain.fontSize);
      expect(linked.fontFamily).toBe(plain.fontFamily);
      expect(linked.backgroundColor).toBe(plain.backgroundColor);
      expect(linked.color).toBe(linked.anchorColor);
      expect(linked.color).not.toBe(plain.color);
    }
    expect(long.lines).toBeGreaterThan(1);
    expect(long.right).toBeLessThanOrEqual(measurements.right + 1);
  } finally {
    await session.cleanup();
  }
});

async function measureInlineCode(message: Locator) {
  return message.evaluate((element) => {
    // Constrain the paragraph to exercise an inline path at a line boundary.
    const paragraph = element.querySelector("p")!;
    paragraph.style.width = "300px";
    const codes = Array.from(paragraph.querySelectorAll("code"), (code) => {
      const style = getComputedStyle(code);
      const range = document.createRange();
      range.selectNodeContents(code);
      const rects = Array.from(range.getClientRects());
      return {
        text: code.textContent,
        fontSize: style.fontSize,
        fontFamily: style.fontFamily,
        backgroundColor: style.backgroundColor,
        color: style.color,
        anchorColor: code.closest("a") ? getComputedStyle(code.closest("a")!).color : null,
        whiteSpace: style.whiteSpace,
        overflowWrap: style.overflowWrap,
        rects: rects.map((rect) => ({ left: rect.left, right: rect.right, top: rect.top })),
        lines: new Set(rects.map((rect) => rect.top)).size,
        right: Math.max(...rects.map((rect) => rect.right)),
      };
    });
    return { codes, right: paragraph.getBoundingClientRect().right };
  });
}

test("inline-code paths preserve stable recognition and file navigation", async ({
  page,
  context,
}, testInfo) => {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const paths = ["src/app/[id].tsx", "src/app/(tabs)/index.tsx", "src/a$b.ts"];
  const source =
    paths.map((path) => `Open \`${path}\`.`).join("\n\n") +
    "\n\nOpen `.gitignore` and `src/index.ts#L10-L20`. Compare before/after and `before/after`. Keep `word.word` plain.";
  const session = await seedMockAgentWorkspace({
    repoPrefix: "inline-path-regression-",
    title: "Inline path regression",
    initialPrompt: "Show file paths",
    featureValues: { mockAssistantResponse: source },
  });
  try {
    await mkdir(`${session.cwd}/src/app/(tabs)`, { recursive: true });
    for (const path of paths) await writeFile(`${session.cwd}/${path}`, `Opened ${path}`);
    await writeFile(
      `${session.cwd}/src/index.ts`,
      Array.from({ length: 30 }, (_, i) => `export const line${i + 1} = ${i + 1};`).join("\n"),
    );
    await session.client.waitForFinish(session.agentId, 30_000);
    await openAgentRoute(page, session);
    const message = page.getByTestId("assistant-message");
    await expect(message.getByRole("link", { name: ".gitignore", exact: true })).toBeVisible();
    await expect(message.getByRole("link", { name: "before/after", exact: true })).toHaveCount(0);
    await expect(message.getByRole("link", { name: "word.word", exact: true })).toHaveCount(0);
    for (const path of paths) {
      await openInlineRegressionFile(page, path);
      await expect(page.getByTestId("file-source-editor").filter({ visible: true })).toContainText(
        `Opened ${path}`,
      );
    }
    await openInlineRegressionFile(page, "src/index.ts#L10-L20");
    await expect(page.getByLabel("Line 20, column 26")).toBeVisible();
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page
      .getByTestId("file-source-editor")
      .filter({ visible: true })
      .locator(".cm-content")
      .focus();
    await page.keyboard.press("ControlOrMeta+c");
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(
        Array.from({ length: 11 }, (_, i) => `export const line${i + 10} = ${i + 10};`).join("\n"),
      );
    await expect(
      page
        .getByTestId("file-source-editor")
        .filter({ visible: true })
        .locator(".cm-selectionBackground"),
    ).not.toHaveCount(0);
    await testInfo.attach("inline-path-line-selection", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  } finally {
    await session.cleanup();
  }
});

async function openInlineRegressionFile(page: Page, path: string) {
  await page.getByRole("button", { name: "Inline path regression", exact: true }).click();
  await page
    .getByTestId("assistant-message")
    .getByRole("link", { name: path, exact: true })
    .click();
}
