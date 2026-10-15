import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect } from "vitest";
import { readPublicationWarning } from "./local-publication-status.js";
test("shows a blocked source audit and clears it after a successful check", () => {
  const root = mkdtempSync(path.join(tmpdir(), "paseo-publication-"));
  const file = path.join(root, "source-audit.json");
  try {
    expect(readPublicationWarning(file)).toBeNull();
    writeFileSync(
      file,
      JSON.stringify({
        blockers: [
          { kind: "unmerged", ref: "refs/heads/browser-tabs" },
          { kind: "dirty", worktree: "/work" },
        ],
      }),
    );
    expect(readPublicationWarning(file)).toContain("2 travaux");
    expect(readPublicationWarning(file)).toContain("Publication bloquée");
    writeFileSync(file, JSON.stringify({ blockers: [] }));
    expect(readPublicationWarning(file)).toBeNull();
    writeFileSync(file, "corrupt");
    expect(readPublicationWarning(file)).toContain("illisible");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
