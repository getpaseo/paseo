import { describe, expect, it } from "vitest";
import { toPreviewText } from "./inbox-reply";

describe("toPreviewText", () => {
  it("flattens a reply to one line of prose", () => {
    expect(toPreviewText("Ausgerollt:\n\n- Daemon  läuft")).toBe("Ausgerollt: Daemon läuft");
  });

  it("drops Markdown marks, links and code fences", () => {
    const text = toPreviewText(
      "## Stand\n- **Linux:** `paseo-live` → [Release](https://x.y)\n```sh\nnpm ci\n```\nfertig",
    );
    expect(text).toBe("Stand Linux: paseo-live → Release fertig");
  });

  it("cuts long replies and returns null for empty ones", () => {
    expect(toPreviewText("x".repeat(400))).toHaveLength(281);
    expect(toPreviewText("```\nonly code\n```")).toBeNull();
  });
});
