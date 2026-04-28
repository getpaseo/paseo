import { describe, it, expect } from "vitest";
import { containsRule, ensureCrgGitignore } from "./gitignore.js";

function makeFakeFs(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  const reads: string[] = [];
  const writes: Array<{ path: string; content: string }> = [];
  return {
    store,
    reads,
    writes,
    read: async (p: string) => {
      reads.push(p);
      if (!store.has(p)) {
        const err = new Error(`ENOENT: no such file ${p}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return store.get(p) as string;
    },
    write: async (p: string, content: string) => {
      writes.push({ path: p, content });
      store.set(p, content);
    },
  };
}

describe("containsRule", () => {
  it.each([
    [".code-review-graph/", true],
    [".code-review-graph", true],
    [".code-review-graph/\n", true],
    ["# comment only\n", false],
    ["", false],
    ["dist/\nnode_modules/\n.code-review-graph/\n", true],
    ["dist/\n# .code-review-graph/\n", false],
    ["!.code-review-graph/\n", true],
  ])("%s -> %s", (content, expected) => {
    expect(containsRule(content, ".code-review-graph/")).toBe(expected);
  });
});

describe("ensureCrgGitignore", () => {
  it("creates the file when missing", async () => {
    const fakeFs = makeFakeFs();
    const result = await ensureCrgGitignore("/repo", {
      readFile: fakeFs.read,
      writeFile: fakeFs.write,
    });
    expect(result.created).toBe(true);
    expect(result.modified).toBe(true);
    expect(fakeFs.writes).toHaveLength(1);
    expect(fakeFs.writes[0]?.content).toContain(".code-review-graph/");
    expect(fakeFs.writes[0]?.content).toContain("# Hubcode code-review-graph index");
  });

  it("appends with a labeled section when file exists without rule", async () => {
    const fakeFs = makeFakeFs({ "/repo/.gitignore": "node_modules\ndist/\n" });
    const result = await ensureCrgGitignore("/repo", {
      readFile: fakeFs.read,
      writeFile: fakeFs.write,
    });
    expect(result.modified).toBe(true);
    expect(result.created).toBe(false);
    const written = fakeFs.writes[0]?.content ?? "";
    expect(written.startsWith("node_modules\ndist/\n")).toBe(true);
    expect(written).toContain("# Hubcode code-review-graph index");
    expect(written).toContain(".code-review-graph/");
  });

  it("inserts a separating newline when the existing file is missing a trailing newline", async () => {
    const fakeFs = makeFakeFs({ "/repo/.gitignore": "node_modules" });
    await ensureCrgGitignore("/repo", { readFile: fakeFs.read, writeFile: fakeFs.write });
    const written = fakeFs.writes[0]?.content ?? "";
    expect(written.startsWith("node_modules\n")).toBe(true);
    expect(written).toMatch(/node_modules\n\n# Hubcode/);
  });

  it("is a no-op when rule is already present", async () => {
    const fakeFs = makeFakeFs({
      "/repo/.gitignore": "dist/\n.code-review-graph/\n",
    });
    const result = await ensureCrgGitignore("/repo", {
      readFile: fakeFs.read,
      writeFile: fakeFs.write,
    });
    expect(result.modified).toBe(false);
    expect(result.created).toBe(false);
    expect(fakeFs.writes).toHaveLength(0);
  });

  it("propagates non-ENOENT errors from the read", async () => {
    const fakeFs = makeFakeFs();
    fakeFs.read = async () => {
      const err = new Error("EACCES") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    };
    await expect(
      ensureCrgGitignore("/repo", { readFile: fakeFs.read, writeFile: fakeFs.write }),
    ).rejects.toThrow(/EACCES/);
  });

  it("respects custom rule and header", async () => {
    const fakeFs = makeFakeFs();
    await ensureCrgGitignore("/repo", {
      readFile: fakeFs.read,
      writeFile: fakeFs.write,
      rule: ".my-index/",
      header: "# Custom header",
    });
    const written = fakeFs.writes[0]?.content ?? "";
    expect(written).toContain("# Custom header");
    expect(written).toContain(".my-index/");
  });
});
