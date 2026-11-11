import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";

const docsRoot = path.resolve(import.meta.dirname, "../../../public-docs");

it.each(["schedules.md", "schedules-cli.md", "mcp.md", "worktrees.md"])(
  "%s makes schedule run retention discoverable",
  async (file) => {
    const markdown = await readFile(path.join(docsRoot, file), "utf8");
    expect(markdown).toContain("Archive on finish");
    if (file !== "schedules.md") {
      expect(markdown).toContain("/docs/schedules#keep-run-workspaces");
    }
  },
);
