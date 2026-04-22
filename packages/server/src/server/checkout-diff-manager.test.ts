import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { toCheckoutErrorMock } = vi.hoisted(() => ({
  toCheckoutErrorMock: vi.fn((error: unknown) => ({
    message: error instanceof Error ? error.message : String(error),
  })),
}));

vi.mock("./checkout-git-utils.js", () => ({
  toCheckoutError: toCheckoutErrorMock,
}));

import { CheckoutDiffManager } from "./checkout-diff-manager.js";

describe("CheckoutDiffManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    toCheckoutErrorMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createManager(options?: {
    repoRoot?: string | null;
    getCheckoutDiffImplementation?: ReturnType<typeof vi.fn>;
  }) {
    const unsubscribe = vi.fn();
    let onChange: (() => void) | null = null;
    const mockRequestWorkingTreeWatch = vi.fn(async (_cwd: string, listener: () => void) => {
      onChange = listener;
      return {
        repoRoot: options?.repoRoot === undefined ? "/tmp/repo" : options.repoRoot,
        unsubscribe,
      };
    });

    const workspaceGitService = {
      subscribe: vi.fn(),
      peekSnapshot: vi.fn(),
      getSnapshot: vi.fn(),
      getCheckoutDiff:
        options?.getCheckoutDiffImplementation ?? vi.fn(async () => ({ diff: "", structured: [] })),
      refresh: vi.fn(),
      scheduleRefreshForCwd: vi.fn(),
      requestWorkingTreeWatch: mockRequestWorkingTreeWatch,
      dispose: vi.fn(),
    };

    const logger = {
      child: () => logger,
      warn: vi.fn(),
    };

    const manager = new CheckoutDiffManager({
      logger: logger as any,
      paseoHome: "/tmp/paseo-test",
      workspaceGitService: workspaceGitService as any,
    });

    return {
      manager,
      workspaceGitService,
      mockRequestWorkingTreeWatch,
      unsubscribe,
      getOnChange: () => onChange,
    };
  }

  test("subscribe requests a working tree watch with the correct cwd", async () => {
    const { manager, mockRequestWorkingTreeWatch } = createManager();

    await manager.subscribe(
      {
        cwd: "/tmp/repo/packages/server",
        compare: { mode: "uncommitted" },
      },
      () => {},
    );

    expect(mockRequestWorkingTreeWatch).toHaveBeenCalledWith(
      "/tmp/repo/packages/server",
      expect.any(Function),
    );
  });

  test("unsubscribe calls the working tree watch unsubscribe", async () => {
    const { manager, unsubscribe } = createManager();

    const subscription = await manager.subscribe(
      {
        cwd: "/tmp/repo/packages/server",
        compare: { mode: "uncommitted" },
      },
      () => {},
    );

    subscription.unsubscribe();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  test("diffCwd uses repoRoot from the working tree watch result", async () => {
    const { manager, workspaceGitService } = createManager({ repoRoot: "/tmp/repo" });

    await manager.subscribe(
      {
        cwd: "/tmp/repo/packages/server",
        compare: { mode: "uncommitted" },
      },
      () => {},
    );

    expect(workspaceGitService.getCheckoutDiff).toHaveBeenCalledWith(
      "/tmp/repo",
      expect.objectContaining({ mode: "uncommitted", includeStructured: true }),
      undefined,
    );
  });

  test("diff refresh is triggered when the working tree watch callback fires", async () => {
    const getCheckoutDiff = vi
      .fn()
      .mockResolvedValueOnce({
        diff: "",
        structured: [{ path: "a.ts", additions: 1, deletions: 0, status: "modified" }],
      })
      .mockResolvedValueOnce({
        diff: "",
        structured: [{ path: "b.ts", additions: 2, deletions: 0, status: "modified" }],
      });

    const { manager, getOnChange } = createManager({
      getCheckoutDiffImplementation: getCheckoutDiff,
    });
    const listener = vi.fn();

    await manager.subscribe(
      {
        cwd: "/tmp/repo/packages/server",
        compare: { mode: "uncommitted" },
      },
      listener,
    );

    const onChange = getOnChange();
    expect(onChange).toBeTypeOf("function");

    onChange?.();
    await vi.advanceTimersByTimeAsync(150);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      cwd: "/tmp/repo/packages/server",
      files: [{ path: "b.ts", additions: 2, deletions: 0, status: "modified" }],
      error: null,
    });
  });

  test("watch-triggered refresh forces a cache bypass on getCheckoutDiff", async () => {
    const getCheckoutDiff = vi
      .fn()
      .mockResolvedValueOnce({
        diff: "",
        structured: [{ path: "a.ts", additions: 1, deletions: 0, status: "modified" }],
      })
      .mockResolvedValueOnce({
        diff: "",
        structured: [{ path: "b.ts", additions: 2, deletions: 0, status: "modified" }],
      });

    const { manager, getOnChange } = createManager({
      getCheckoutDiffImplementation: getCheckoutDiff,
    });

    await manager.subscribe(
      {
        cwd: "/tmp/repo/packages/server",
        compare: { mode: "uncommitted" },
      },
      vi.fn(),
    );

    expect(getCheckoutDiff).toHaveBeenNthCalledWith(
      1,
      "/tmp/repo",
      expect.objectContaining({ mode: "uncommitted" }),
      undefined,
    );

    const onChange = getOnChange();
    onChange?.();
    await vi.advanceTimersByTimeAsync(150);

    expect(getCheckoutDiff).toHaveBeenCalledTimes(2);
    const watchFiredCall = getCheckoutDiff.mock.calls[1];
    expect(watchFiredCall[2]).toEqual({
      force: true,
      reason: expect.stringContaining("working-tree"),
    });
  });

  test("falls back to cwd when the working tree watch returns no repo root", async () => {
    const { manager, workspaceGitService } = createManager({ repoRoot: null });

    await manager.subscribe(
      {
        cwd: "/tmp/plain",
        compare: { mode: "uncommitted" },
      },
      () => {},
    );

    expect(workspaceGitService.getCheckoutDiff).toHaveBeenCalledWith(
      "/tmp/plain",
      expect.objectContaining({ mode: "uncommitted", includeStructured: true }),
      undefined,
    );
  });
});
