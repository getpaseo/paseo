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
});
