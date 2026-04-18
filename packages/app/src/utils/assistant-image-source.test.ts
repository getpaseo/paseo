import { describe, expect, it } from "vitest";

import { resolveAssistantImageSource } from "./assistant-image-source";

describe("resolveAssistantImageSource", () => {
  it("passes through direct image URIs", () => {
    expect(resolveAssistantImageSource({ source: "https://example.com/image.png" })).toEqual({
      kind: "direct",
      uri: "https://example.com/image.png",
    });
    expect(resolveAssistantImageSource({ source: "data:image/png;base64,abc" })).toEqual({
      kind: "direct",
      uri: "data:image/png;base64,abc",
    });
  });

  it("uses the workspace root for relative paths", () => {
    expect(
      resolveAssistantImageSource({
        source: "screenshots/output.png",
        workspaceRoot: "/Users/test/project",
      }),
    ).toEqual({
      kind: "file_rpc",
      cwd: "/Users/test/project",
      path: "screenshots/output.png",
    });
  });

  it("uses the workspace root for absolute paths inside the workspace", () => {
    expect(
      resolveAssistantImageSource({
        source: "/Users/test/project/screenshots/output.png",
        workspaceRoot: "/Users/test/project",
      }),
    ).toEqual({
      kind: "file_rpc",
      cwd: "/Users/test/project",
      path: "/Users/test/project/screenshots/output.png",
    });
  });

  it("falls back to filesystem root for absolute paths outside the workspace", () => {
    expect(
      resolveAssistantImageSource({
        source: "/tmp/paseo-codex-screenshot.png",
        workspaceRoot: "/Users/test/project",
      }),
    ).toEqual({
      kind: "file_rpc",
      cwd: "/",
      path: "/tmp/paseo-codex-screenshot.png",
    });
  });

  it("normalizes file URIs into file RPC requests", () => {
    expect(
      resolveAssistantImageSource({
        source: "file:///tmp/paseo-codex-screenshot.png",
        workspaceRoot: "/Users/test/project",
      }),
    ).toEqual({
      kind: "file_rpc",
      cwd: "/",
      path: "/tmp/paseo-codex-screenshot.png",
    });
  });

  it("falls back to the drive root for Windows absolute paths", () => {
    expect(
      resolveAssistantImageSource({
        source: "C:/Users/test/Desktop/screenshot.png",
        workspaceRoot: "D:/repo",
      }),
    ).toEqual({
      kind: "file_rpc",
      cwd: "C:/",
      path: "C:/Users/test/Desktop/screenshot.png",
    });
  });
});
