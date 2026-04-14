import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { getCheckoutDiffMock, resolveCheckoutGitDirMock, readdirMock, watchCalls } = vi.hoisted(
  () => {
    const hoistedWatchCalls: Array<{ path: string; close: ReturnType<typeof vi.fn> }> = [];
    return {
      getCheckoutDiffMock: vi.fn(async () => ({ diff: "", structured: [] })),
      resolveCheckoutGitDirMock: vi.fn(async () => "/tmp/repo/.git"),
      readdirMock: vi.fn(async (directory: string) => {
        if (directory === "/tmp/repo") {
          return [
            { name: "packages", isDirectory: () => true },
            { name: ".git", isDirectory: () => true },
            { name: "README.md", isDirectory: () => false },
          ];
        }
        if (directory === path.join("/tmp/repo", "packages")) {
          return [
            { name: "server", isDirectory: () => true },
            { name: "app", isDirectory: () => true },
          ];
        }
        if (directory === path.join("/tmp/repo", "packages", "server")) {
          return [{ name: "src", isDirectory: () => true }];
        }
        if (directory === path.join("/tmp/repo", "packages", "server", "src")) {
          return [{ name: "server", isDirectory: () => true }];
        }
        return [];
      }),
      watchCalls: hoistedWatchCalls,
    };
  },
);

vi.mock("../utils/run-git-command.js", () => ({
  runGitCommand: vi.fn(async () => ({
    stdout: "/tmp/repo\n",
    stderr: "",
    truncated: false,
    exitCode: 0,
    signal: null,
  })),
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    readdir: readdirMock,
  };
});

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    watch: vi.fn((watchPath: string) => {
      const close = vi.fn();
      watchCalls.push({ path: watchPath, close });
      return {
        close,
        on: vi.fn().mockReturnThis(),
      } as any;
    }),
  };
});

vi.mock("../utils/checkout-git.js", () => ({
  getCheckoutDiff: getCheckoutDiffMock,
}));

vi.mock("./checkout-git-utils.js", () => ({
  READ_ONLY_GIT_ENV: {},
  resolveCheckoutGitDir: resolveCheckoutGitDirMock,
  toCheckoutError: vi.fn((error: unknown) => ({
    message: error instanceof Error ? error.message : String(error),
  })),
}));

import { CheckoutDiffManager } from "./checkout-diff-manager.js";

function createStructuredFile(options?: {
  path?: string;
  addContent?: string;
  tokenStyle?: string;
}): {
  path: string;
  isNew: boolean;
  isDeleted: boolean;
  additions: number;
  deletions: number;
  hunks: Array<{
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
    lines: Array<{ type: "header" | "context" | "add"; content: string; tokens?: unknown[] }>;
  }>;
  status: "ok";
} {
  const addContent = options?.addContent ?? "const value = 2;";
  return {
    path: options?.path ?? "src/example.ts",
    isNew: false,
    isDeleted: false,
    additions: 1,
    deletions: 0,
    hunks: [
      {
        oldStart: 1,
        oldCount: 1,
        newStart: 1,
        newCount: 2,
        lines: [
          { type: "header", content: "@@ -1,1 +1,2 @@" },
          { type: "context", content: "const value = 1;" },
          {
            type: "add",
            content: addContent,
            tokens: [{ text: "const", style: options?.tokenStyle ?? "keyword" }],
          },
        ],
      },
    ],
    status: "ok",
  };
}

describe("CheckoutDiffManager Linux watchers", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    watchCalls.length = 0;
    getCheckoutDiffMock.mockClear();
    resolveCheckoutGitDirMock.mockClear();
    readdirMock.mockClear();
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "linux",
    });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform,
    });
  });

  test("watches nested repository directories on Linux", async () => {
    const logger = {
      child: () => logger,
      warn: vi.fn(),
    };
    const manager = new CheckoutDiffManager({
      logger: logger as any,
      paseoHome: "/tmp/paseo-test",
    });

    const subscription = await manager.subscribe(
      {
        cwd: path.join("/tmp/repo", "packages", "server"),
        compare: { mode: "uncommitted" },
      },
      () => {},
    );

    expect(subscription.initial.error).toBeNull();
    expect(watchCalls.map((entry) => entry.path).sort()).toEqual([
      "/tmp/repo",
      "/tmp/repo/.git",
      "/tmp/repo/packages",
      "/tmp/repo/packages/app",
      "/tmp/repo/packages/server",
      "/tmp/repo/packages/server/src",
      "/tmp/repo/packages/server/src/server",
    ]);

    subscription.unsubscribe();
    manager.dispose();
  });

  test("subscribeLazy returns metadata snapshots and caches file hunks", async () => {
    getCheckoutDiffMock.mockResolvedValueOnce({
      diff: "",
      structured: [createStructuredFile()],
    });

    const logger = {
      child: () => logger,
      warn: vi.fn(),
    };
    const manager = new CheckoutDiffManager({
      logger: logger as any,
      paseoHome: "/tmp/paseo-test",
    });

    const listener = vi.fn();
    const subscription = await manager.subscribeLazy(
      {
        cwd: path.join("/tmp/repo", "packages", "server"),
        compare: { mode: "uncommitted" },
      },
      listener,
    );

    expect(subscription.initial.error).toBeNull();
    expect(subscription.initial.files).toEqual([
      expect.objectContaining({
        path: "src/example.ts",
        additions: 1,
        deletions: 0,
        fingerprint: expect.any(String),
      }),
    ]);
    expect((subscription.initial.files[0] as any).hunks).toBeUndefined();
    expect(
      manager.getFileHunks(
        path.join("/tmp/repo", "packages", "server"),
        { mode: "uncommitted" },
        "src/example.ts",
      ),
    ).toEqual(createStructuredFile().hunks);

    subscription.unsubscribe();
    manager.dispose();
  });

  test("lazy metadata fingerprint ignores token-only changes but emits on hunk changes", async () => {
    getCheckoutDiffMock.mockResolvedValueOnce({
      diff: "",
      structured: [createStructuredFile({ tokenStyle: "keyword" })],
    });
    getCheckoutDiffMock.mockResolvedValueOnce({
      diff: "",
      structured: [createStructuredFile({ tokenStyle: "variableName" })],
    });
    getCheckoutDiffMock.mockResolvedValueOnce({
      diff: "",
      structured: [createStructuredFile({ addContent: "const value = 3;" })],
    });

    const logger = {
      child: () => logger,
      warn: vi.fn(),
    };
    const manager = new CheckoutDiffManager({
      logger: logger as any,
      paseoHome: "/tmp/paseo-test",
    });

    const listener = vi.fn();
    await manager.subscribeLazy(
      {
        cwd: path.join("/tmp/repo", "packages", "server"),
        compare: { mode: "uncommitted" },
      },
      listener,
    );

    const target = Array.from((manager as any).targets.values())[0];
    await (manager as any).refreshTarget(target);
    expect(listener).not.toHaveBeenCalled();

    await (manager as any).refreshTarget(target);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({
        files: [
          expect.objectContaining({
            path: "src/example.ts",
            fingerprint: expect.any(String),
          }),
        ],
      }),
    );

    manager.dispose();
  });
});
