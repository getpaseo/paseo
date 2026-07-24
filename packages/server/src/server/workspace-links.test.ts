import { describe, expect, it } from "vitest";
import { getScriptConfigs } from "../utils/worktree.js";
import { buildWorkspaceLinkPayloads } from "./workspace-links.js";

describe("buildWorkspaceLinkPayloads", () => {
  it("substitutes and URL-encodes the workspace path", () => {
    expect(
      buildWorkspaceLinkPayloads({
        paseoConfig: {
          scripts: {
            "Open in code-server": {
              type: "link",
              url: "https://code.razvoj.app/?folder={workspacePath}",
            },
          },
        },
        workspacePath: "/work/workspace/feature one",
      }),
    ).toEqual([
      {
        name: "Open in code-server",
        url: "https://code.razvoj.app/?folder=%2Fwork%2Fworkspace%2Ffeature%20one",
      },
    ]);
  });

  it("ignores commands and empty link entries", () => {
    expect(
      buildWorkspaceLinkPayloads({
        paseoConfig: {
          scripts: {
            build: { command: "npm run build" },
            empty: { type: "link", url: "   " },
          },
        },
        workspacePath: "/work/workspace/project",
      }),
    ).toEqual([]);
  });

  it("ignores malformed and non-HTTP links from hand-edited configs", () => {
    expect(
      buildWorkspaceLinkPayloads({
        paseoConfig: {
          scripts: {
            malformed: { type: "link", url: "not a URL" },
            local: { type: "link", url: "file://{workspacePath}" },
            script: { type: "link", url: "javascript:alert(1)" },
            valid: { type: "link", url: "https://example.com/{workspacePath}" },
          },
        },
        workspacePath: "/work/workspace/project",
      }),
    ).toEqual([
      {
        name: "valid",
        url: "https://example.com/%2Fwork%2Fworkspace%2Fproject",
      },
    ]);
  });

  it("does not expose links as server-side commands", () => {
    expect(
      getScriptConfigs({
        scripts: {
          "Open in code-server": {
            type: "link",
            url: "https://code.razvoj.app/?folder={workspacePath}",
          },
        },
      }),
    ).toEqual(new Map());
  });
});
