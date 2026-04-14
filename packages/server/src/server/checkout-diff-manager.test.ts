import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const {
  getCheckoutDiffMock,
  resolveCheckoutGitDirMock,
  runGitCommandMock,
  readdirMock,
  readFileMock,
  watchCalls,
  gitIgnoreContents,
  trackedFiles,
} = vi.hoisted(() => {
  const hoistedWatchCalls: Array<{
    path: string;
    close: ReturnType<typeof vi.fn>;
    callback: () => void;
  }> = [];
  const hoistedGitIgnoreContents = {
    root: "vendor/\nnode_modules/\n",
  };
  const hoistedTrackedFiles = {
    root: ["packages/server/src/server/index.ts"],
  };
  return {
    getCheckoutDiffMock: vi.fn(async () => ({ diff: "", structured: [] })),
    resolveCheckoutGitDirMock: vi.fn(async () => "/tmp/repo/.git"),
    runGitCommandMock: vi.fn(async (args: string[]) => {
      if (args[0] === "rev-parse") {
        return {
          stdout: "/tmp/repo\n",
          stderr: "",
          truncated: false,
          exitCode: 0,
          signal: null,
        };
      }

      if (args[0] === "ls-files") {
        return {
          stdout: `${hoistedTrackedFiles.root.join("\n")}\n`,
          stderr: "",
          truncated: false,
          exitCode: 0,
          signal: null,
        };
      }

      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    }),
    readdirMock: vi.fn(async (directory: string) => {
      if (directory === "/tmp/repo") {
        return [
          { name: "packages", isDirectory: () => true },
          { name: "vendor", isDirectory: () => true },
          { name: "node_modules", isDirectory: () => true },
          { name: ".git", isDirectory: () => true },
          { name: ".gitignore", isDirectory: () => false },
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
    readFileMock: vi.fn(async (filePath: string) => {
      if (filePath === path.join("/tmp/repo", ".gitignore")) {
        return hoistedGitIgnoreContents.root;
      }
      throw new Error(`Unexpected readFile: ${filePath}`);
    }),
    gitIgnoreContents: hoistedGitIgnoreContents,
    trackedFiles: hoistedTrackedFiles,
    watchCalls: hoistedWatchCalls,
  };
});

vi.mock("../utils/run-git-command.js", () => ({
  runGitCommand: runGitCommandMock,
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    readdir: readdirMock,
    readFile: readFileMock,
  };
});

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    watch: vi.fn((watchPath: string, _options: unknown, callback: () => void) => {
      const close = vi.fn();
      watchCalls.push({ path: watchPath, close, callback });
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
    runGitCommandMock.mockClear();
    readdirMock.mockClear();
    readFileMock.mockClear();
    gitIgnoreContents.root = "vendor/\nnode_modules/\n";
    trackedFiles.root = ["packages/server/src/server/index.ts"];
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

  test("skips directories ignored by .gitignore on Linux", async () => {
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

    const watchedPaths = watchCalls.map((entry) => entry.path);
    expect(watchedPaths).not.toContain(path.join("/tmp/repo", "vendor"));
    expect(watchedPaths).not.toContain(path.join("/tmp/repo", "node_modules"));

    subscription.unsubscribe();
    manager.dispose();
  });

  test("prunes stale watchers after .gitignore starts ignoring a directory", async () => {
    const logger = {
      child: () => logger,
      warn: vi.fn(),
    };
    gitIgnoreContents.root = "node_modules/\n";
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

    const vendorWatcher = watchCalls.find(
      (entry) => entry.path === path.join("/tmp/repo", "vendor"),
    );
    expect(vendorWatcher).toBeDefined();

    gitIgnoreContents.root = "vendor/\nnode_modules/\n";
    const rootWatcher = watchCalls.find((entry) => entry.path === "/tmp/repo");
    expect(rootWatcher).toBeDefined();

    rootWatcher?.callback();
    await vi.waitFor(() => {
      expect(vendorWatcher?.close).toHaveBeenCalledTimes(1);
    });

    subscription.unsubscribe();
    manager.dispose();
  });

  test("keeps watching ignored directories that contain tracked files", async () => {
    const logger = {
      child: () => logger,
      warn: vi.fn(),
    };
    trackedFiles.root = ["packages/server/src/server/index.ts", "vendor/kept.txt"];
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

    expect(watchCalls.map((entry) => entry.path)).toContain(path.join("/tmp/repo", "vendor"));

    subscription.unsubscribe();
    manager.dispose();
  });

  test("keeps ignored directories watched when tracked file lookup fails", async () => {
    const logger = {
      child: () => logger,
      warn: vi.fn(),
    };
    runGitCommandMock.mockImplementationOnce(async (args: string[]) => {
      if (args[0] === "rev-parse") {
        return {
          stdout: "/tmp/repo\n",
          stderr: "",
          truncated: false,
          exitCode: 0,
          signal: null,
        };
      }

      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });
    runGitCommandMock.mockImplementationOnce(async () => {
      throw new Error("git ls-files failed");
    });

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

    const watchedPaths = watchCalls.map((entry) => entry.path);
    expect(watchedPaths).toContain(path.join("/tmp/repo", "vendor"));
    expect(watchedPaths).toContain(path.join("/tmp/repo", "node_modules"));

    subscription.unsubscribe();
    manager.dispose();
  });
});
