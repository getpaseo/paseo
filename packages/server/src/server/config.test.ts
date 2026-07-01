import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";

import { resolveBundledWebUiDistDir } from "./config.js";

function fileUrlFor(...segments: string[]): URL {
  return pathToFileURL(path.join(path.parse(process.cwd()).root, ...segments));
}

describe("server config", () => {
  test("resolves bundled web UI path from source-tree modules", () => {
    expect(
      resolveBundledWebUiDistDir(
        fileUrlFor("repo", "packages", "server", "src", "server", "config.ts"),
      ),
    ).toBe(
      path.join(
        path.parse(process.cwd()).root,
        "repo",
        "packages",
        "server",
        "dist",
        "server",
        "web-ui",
      ),
    );
  });

  test("resolves bundled web UI path from globally installed compiled modules", () => {
    expect(
      resolveBundledWebUiDistDir(
        fileUrlFor(
          "usr",
          "local",
          "lib",
          "node_modules",
          "@getpaseo",
          "server",
          "dist",
          "server",
          "server",
          "config.js",
        ),
      ),
    ).toBe(
      path.join(
        path.parse(process.cwd()).root,
        "usr",
        "local",
        "lib",
        "node_modules",
        "@getpaseo",
        "server",
        "dist",
        "server",
        "web-ui",
      ),
    );
  });
});
