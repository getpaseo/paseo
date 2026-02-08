import { describe, expect, it } from "vitest";

import {
  extractTodos,
  stripCwdPrefix,
  stripShellWrapperPrefix,
} from "./tool-call-parsers.js";

describe("tool-call-parsers utilities", () => {
  it("strips cwd prefixes", () => {
    expect(stripCwdPrefix("/tmp/repo/src/index.ts", "/tmp/repo")).toBe("src/index.ts");
    expect(stripCwdPrefix("/tmp/repo", "/tmp/repo")).toBe(".");
  });

  it("strips shell wrapper prefixes", () => {
    const wrapped = '/bin/zsh -lc "cd /tmp/repo && npm test"';
    expect(stripShellWrapperPrefix(wrapped)).toBe("npm test");
  });

  it("extracts todo entries", () => {
    expect(
      extractTodos({
        todos: [
          { content: "Task 1", status: "pending" },
          { content: "Task 2", status: "completed" },
        ],
      })
    ).toHaveLength(2);

    expect(extractTodos({ plan: [] })).toEqual([]);
  });
});
