import type { Locator } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

const WIDE_TABLE = [
  "| Provider | Model | Context window | Input price | Output price | Tool use | Vision | Notes |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
  "| Anthropic | claude-sonnet | 200k tokens | $3.00 | $15.00 | yes | yes | Default for coding agents |",
  "| OpenAI | gpt-codex | 400k tokens | $1.25 | $10.00 | yes | yes | Needs a paid plan |",
  "| Local | qwen-coder | 32k tokens | free | free | partial | no | Runs on the host GPU |",
].join("\n");

const NARROW_TABLE = [
  "| Key | Value |",
  "| --- | --- |",
  "| mode | fast |",
  "| retries | 3 |",
].join("\n");

const RESPONSE = ["Wide table:", "", WIDE_TABLE, "", "Narrow table:", "", NARROW_TABLE].join("\n");

// Below this a column breaks header words like "Provider" mid-word at the chat font size.
const MIN_READABLE_COLUMN_WIDTH = 64;

interface TableLayout {
  columnCount: number;
  rows: CellBox[][];
  scrollFrame: { clientWidth: number; scrollWidth: number } | null;
  tableWidth: number;
  messageWidth: number;
}

interface CellBox {
  left: number;
  width: number;
}

async function readTableLayout(table: Locator): Promise<TableLayout> {
  return table.evaluate((element) => {
    function horizontalScrollFrame(start: Element): HTMLElement | null {
      let current = start.parentElement;
      while (current && !current.matches('[data-testid="assistant-message"]')) {
        const overflowX = getComputedStyle(current).overflowX;
        if (overflowX === "auto" || overflowX === "scroll") return current;
        current = current.parentElement;
      }
      return null;
    }

    const rows = Array.from(element.querySelectorAll('[data-paseo-markdown-tag="tr"]')).map((row) =>
      Array.from(row.children).map((cell) => {
        const box = cell.getBoundingClientRect();
        return { left: box.left - element.getBoundingClientRect().left, width: box.width };
      }),
    );
    const frame = horizontalScrollFrame(element);
    const message = element.closest('[data-testid="assistant-message"]');
    if (!message) throw new Error("Table is not inside an assistant message");
    return {
      columnCount: element.querySelectorAll('[data-paseo-markdown-tag="th"]').length,
      rows,
      scrollFrame: frame
        ? { clientWidth: frame.clientWidth, scrollWidth: frame.scrollWidth }
        : null,
      tableWidth: element.getBoundingClientRect().width,
      messageWidth: message.getBoundingClientRect().width,
    };
  });
}

function expectAlignedColumns(layout: TableLayout): void {
  const [header, ...body] = layout.rows;
  expect(header).toHaveLength(layout.columnCount);
  for (const row of body) {
    expect(row).toHaveLength(layout.columnCount);
    row.forEach((cell, column) => {
      expect(Math.abs(cell.left - header[column].left)).toBeLessThanOrEqual(1);
      expect(Math.abs(cell.width - header[column].width)).toBeLessThanOrEqual(1);
    });
  }
}

test("wide assistant tables keep readable columns and scroll inside the message", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "assistant-markdown-table-",
    title: "Assistant markdown table",
    initialPrompt: "Render the configured tables.",
    featureValues: { mockAssistantResponse: RESPONSE },
  });

  try {
    await agent.client.waitForFinish(agent.agentId, 30_000);
    await openAgentRoute(page, agent);

    const tables = page
      .locator('[data-testid="assistant-message"]:visible')
      .locator('[data-paseo-markdown-tag="table"]');
    await expect(tables).toHaveCount(2, { timeout: 30_000 });

    const wide = await readTableLayout(tables.nth(0));
    expect(wide.columnCount).toBe(8);
    expectAlignedColumns(wide);
    for (const cell of wide.rows[0]) {
      expect(cell.width).toBeGreaterThanOrEqual(MIN_READABLE_COLUMN_WIDTH);
    }
    expect(wide.scrollFrame).not.toBeNull();
    expect(wide.scrollFrame!.scrollWidth).toBeGreaterThan(wide.scrollFrame!.clientWidth);
    expect(wide.scrollFrame!.clientWidth).toBeLessThanOrEqual(wide.messageWidth);

    const narrow = await readTableLayout(tables.nth(1));
    expect(narrow.columnCount).toBe(2);
    expectAlignedColumns(narrow);
    expect(narrow.scrollFrame).not.toBeNull();
    expect(narrow.scrollFrame!.scrollWidth).toBe(narrow.scrollFrame!.clientWidth);
    expect(Math.abs(narrow.tableWidth - narrow.scrollFrame!.clientWidth)).toBeLessThanOrEqual(1);

    const pageOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(pageOverflow).toBe(0);

    // The same table fits a desktop-width message without scrolling.
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect
      .poll(async () => {
        const frame = (await readTableLayout(tables.nth(0))).scrollFrame;
        return frame ? frame.scrollWidth - frame.clientWidth : null;
      })
      .toBe(0);
    const desktopWide = await readTableLayout(tables.nth(0));
    expectAlignedColumns(desktopWide);
    expect(
      Math.abs(desktopWide.tableWidth - desktopWide.scrollFrame!.clientWidth),
    ).toBeLessThanOrEqual(1);
  } finally {
    await agent.cleanup();
  }
});
