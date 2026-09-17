import { describe, expect, it } from "vitest";
import { parsePluginSourceReference } from "./plugin-source-reference.js";

describe("plugin source references", () => {
  it.each([
    ["npm:review@1.2.0:nested", "npm:review@1.2.0", "nested"],
    ["npm:review@^1.2.0", "npm:review@^1.2.0", undefined],
    ["npm:@team/review@next:plugins/main", "npm:@team/review@next", "plugins/main"],
    ["github:owner/repository", "github:owner/repository", undefined],
    [
      "git:git@example.test:owner/repository.git",
      "git:git@example.test:owner/repository.git",
      undefined,
    ],
    ["git:file:///repo:plugins/main", "git:file:///repo", "plugins/main"],
    ["owner/repository", "owner/repository", undefined],
    ["owner/repository:plugins/review", "owner/repository", "plugins/review"],
    [
      "https://example.test:8443/owner/repository.git",
      "https://example.test:8443/owner/repository.git",
      undefined,
    ],
    [
      "https://example.test:8443/owner/repository.git:plugins/review",
      "https://example.test:8443/owner/repository.git",
      "plugins/review",
    ],
    ["git@example.test:owner/repository.git", "git@example.test:owner/repository.git", undefined],
    [
      "git@example.test:owner/repository.git:plugins/review",
      "git@example.test:owner/repository.git",
      "plugins/review",
    ],
    ["file:///D:/plugins/repository", "file:///D:/plugins/repository", undefined],
    [
      "file:///D:/plugins/repository:plugins/review",
      "file:///D:/plugins/repository",
      "plugins/review",
    ],
    ["D:\\plugins\\repository", "D:\\plugins\\repository", undefined],
    ["D:\\plugins\\repository:plugins/review", "D:\\plugins\\repository", "plugins/review"],
  ])("parses %s", (reference, source, pluginPath) => {
    expect(parsePluginSourceReference(reference)).toEqual({ source, pluginPath });
  });
});
