import { act } from "react";
import { createRoot } from "react-dom/client";
import { within, waitFor } from "@testing-library/dom";
import { EnrichedMarkdownText } from "react-native-enriched-markdown";
import { expect, it } from "vitest";
import { normalizeMarkdownHtml } from "./html";

const FLAGS = { hardSoftBreaks: true, latexMath: false };

it("renders HTML breaks on separate lines inside the same table cell", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    act(() =>
      root.render(
        <EnrichedMarkdownText
          markdown={normalizeMarkdownHtml(
            "| A | B |\n|---|---|\n| 1 | first<br/>second |\n| 2 | first<br />second |\n| 3 | first<br>second |",
          )}
          md4cFlags={FLAGS}
        />,
      ),
    );
    await waitFor(() => expect(within(container).getAllByRole("row")).toHaveLength(4));
    for (const row of within(container).getAllByRole("row").slice(1)) {
      const cell = within(row).getAllByRole("cell")[1];
      expect(cell.innerText).toBe("first\nsecond");
      const first = document.createRange();
      first.selectNodeContents(cell.firstChild!);
      const second = document.createRange();
      second.selectNodeContents(cell.lastChild!);
      expect(second.getBoundingClientRect().top).toBeGreaterThan(first.getBoundingClientRect().top);
    }
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
