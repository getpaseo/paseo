import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import { openFileExplorer, openFileFromExplorer } from "../support/helpers/file-explorer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

const CHAT_MATH_RESPONSE = [
  "省容量与读延迟：只在 $2^k$ 翻倍点建 Key，当亲和阈值$\\theta \\in [0.5, 1.0]$（默认 0.80）时，读区间 $[\\text{floorLevel}(\\theta N_w), N_w]$ 的上下界比值不超过 2，因此**ReadSet 在数学上永远 $\\le 2$ 个 Key**。",
  [
    "$$",
    "\\begin{aligned}",
    "|\\text{ReadSet}(N_w)| &= \\left\\lfloor \\log_2 N_w \\right\\rfloor - \\left\\lfloor \\log_2 (\\theta N_w) \\right\\rfloor + 1 \\\\",
    "&\\le 2 \\quad \\forall \\theta \\in [0.5, 1.0]",
    "\\end{aligned}",
    "$$",
  ].join("\n"),
  "Pricing stays literal: $50 to $100/yr ($50-$100 or 40$), USD ($) / CAD ($), and `$HOME` or $PATH:$HOME — while $(n + 1)$ seats cost $20(n+1)$.",
].join("\n\n");

const PREVIEW_MATH_DOC = [
  "# LaTeX Math & Currency Notes",
  "",
  "Gaussian integral and transformation matrix:",
  "",
  "$$",
  "\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}",
  "$$",
  "",
  "$$",
  "A = \\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}, \\quad \\det(A) = ad - bc",
  "$$",
  "",
  "| Tier | Billing | Seat Formula |",
  "| --- | --- | --- |",
  "| Team | $20/mo ($50 to $100 cap) | $20(n + 1)$ for $(n + 1)$ seats |",
].join("\n");

function findQuery(page: Page) {
  return page.getByRole("textbox", { name: "Find in pane", exact: true });
}

function findStatus(page: Page) {
  return page.getByRole("status", { name: "Find matches" });
}

test("renders inline and display LaTeX as MathML across chat and Markdown preview while preserving currency literals", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);

  const session = await seedMockAgentWorkspace({
    repoPrefix: "latex-math-rendering-",
    title: "LaTeX Math Rendering",
    featureValues: { mockAssistantResponse: CHAT_MATH_RESPONSE },
    initialPrompt: "Explain the KV-cache read-set bound and seat pricing formula.",
  });

  try {
    await writeFile(path.join(session.cwd, "math-notes.md"), PREVIEW_MATH_DOC);
    await session.client.waitForFinish(session.agentId, 30_000);
    await openAgentRoute(page, session);

    const message = page.getByTestId("assistant-message");
    await expect(message).toBeVisible();
    await expect(message.locator('math[display="block"]')).toHaveCount(1);
    await expect(message.locator('math:not([display="block"])')).toHaveCount(6);
    await expect(message).toContainText("$50 to $100/yr ($50-$100 or 40$)");
    await expect(message).toContainText("USD ($) / CAD ($)");
    await expect(message).toContainText("$PATH:$HOME");
    await expect(message).not.toContainText("\\$");

    await testInfo.attach("latex-math-chat", {
      body: await page.screenshot({ path: testInfo.outputPath("latex-math-chat.png") }),
      contentType: "image/png",
    });

    await message.click();
    await page.keyboard.press("Control+f");
    await expect(findQuery(page)).toBeVisible();
    await findQuery(page).fill("floorLevel");
    await expect(findStatus(page)).toHaveText("1 of 1");
    await findQuery(page).fill("θ");
    await expect(findStatus(page)).toHaveText("1 of 4");
    await findQuery(page).press("Enter");
    await expect(findStatus(page)).toHaveText("2 of 4");
    await findQuery(page).fill("≤");
    await expect(findStatus(page)).toHaveText("1 of 2");
    await page.keyboard.press("Escape");
    await expect(findQuery(page)).toBeHidden();

    await openFileExplorer(page);
    await openFileFromExplorer(page, "math-notes.md");

    const preview = page.getByTestId("markdown-preview-frame").filter({ visible: true });
    await expect(preview).toBeVisible();
    await expect(preview.locator('math[display="block"]')).toHaveCount(2);
    await expect(preview.locator('math:not([display="block"])')).toHaveCount(2);
    await expect(preview.getByRole("table")).toContainText("$20/mo ($50 to $100 cap)");
    await expect(preview).not.toContainText("\\$");

    await testInfo.attach("latex-math-preview", {
      body: await page.screenshot({ path: testInfo.outputPath("latex-math-preview.png") }),
      contentType: "image/png",
    });
  } finally {
    await session.cleanup();
  }
});
