import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { getCheckoutDiffMock, toCheckoutErrorMock } = vi.hoisted(() => ({
  getCheckoutDiffMock: vi.fn(async () => ({ diff: "", structured: [] })),
  toCheckoutErrorMock: vi.fn((error: unknown) => ({
    message: error instanceof Error ? error.message : String(error),
  })),
}));

vi.mock("../utils/checkout-git.js", () => ({
  getCheckoutDiff: getCheckoutDiffMock,
}));

vi.mock("./checkout-git-utils.js", () => ({
  toCheckoutError: toCheckoutErrorMock,
}));

import { CheckoutDiffManager } from "./checkout-diff-manager.js";

describe("CheckoutDiffManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getCheckoutDiffMock.mockReset();
    getCheckoutDiffMock.mockResolvedValue({ diff: "", structured: [] });
    toCheckoutErrorMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createManager(options?: {
    repoRoot?: string | null;
    getCheckoutDiffImplementation?: typeof getCheckoutDiffMock;
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
      refresh: vi.fn(),
      scheduleRefreshForCwd: vi.fn(),
      requestWorkingTreeWatch: mockRequestWorkingTreeWatch,
      dispose: vi.fn(),
    };

    if (options?.getCheckoutDiffImplementation) {
      getCheckoutDiffMock.mockImplementation(options.getCheckoutDiffImplementation);
    }

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
    const { manager } = createManager({ repoRoot: "/tmp/repo" });

    await manager.subscribe(
      {
        cwd: "/tmp/repo/packages/server",
        compare: { mode: "uncommitted" },
      },
      () => {},
    );

    expect(getCheckoutDiffMock).toHaveBeenCalledWith(
      "/tmp/repo",
      expect.objectContaining({ mode: "uncommitted", includeStructured: true }),
      { paseoHome: "/tmp/paseo-test" },
    );
  });

  test("diff refresh is triggered when the working tree watch callback fires", async () => {
    getCheckoutDiffMock
      .mockResolvedValueOnce({
        diff: "",
        structured: [{ path: "a.ts", additions: 1, deletions: 0, status: "modified" }],
      })
      .mockResolvedValueOnce({
        diff: "",
        structured: [{ path: "b.ts", additions: 2, deletions: 0, status: "modified" }],
      });

    const { manager, getOnChange } = createManager();
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

  test("falls back to cwd when the working tree watch returns no repo root", async () => {
    const { manager } = createManager({ repoRoot: null });

    await manager.subscribe(
      {
        cwd: "/tmp/plain",
        compare: { mode: "uncommitted" },
      },
      () => {},
    );

    expect(getCheckoutDiffMock).toHaveBeenCalledWith(
      "/tmp/plain",
      expect.objectContaining({ mode: "uncommitted", includeStructured: true }),
      { paseoHome: "/tmp/paseo-test" },
    );
  });
});
