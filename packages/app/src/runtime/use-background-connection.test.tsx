/** @vitest-environment jsdom */
import { renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useBackgroundConnection } from "./use-background-connection";

const runtime = vi.hoisted(() => ({
  store: {},
  bind: vi.fn(),
  unbind: vi.fn(),
}));

vi.mock("@/runtime/background-connection", () => ({
  bindPlatformBackgroundConnection: runtime.bind,
}));
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => runtime.store,
}));

beforeEach(() => {
  runtime.bind.mockReset();
  runtime.unbind.mockReset();
  runtime.bind.mockReturnValue(runtime.unbind);
});

it("starts the keeper only after enabling it and stops it immediately when disabled", () => {
  const { rerender, unmount } = renderHook(({ enabled }) => useBackgroundConnection(enabled), {
    initialProps: { enabled: false },
  });
  expect(runtime.bind).not.toHaveBeenCalled();

  rerender({ enabled: true });
  expect(runtime.bind).toHaveBeenCalledOnce();
  expect(runtime.bind).toHaveBeenCalledWith(runtime.store);

  rerender({ enabled: false });
  expect(runtime.unbind).toHaveBeenCalledOnce();

  rerender({ enabled: true });
  expect(runtime.bind).toHaveBeenCalledTimes(2);
  unmount();
  expect(runtime.unbind).toHaveBeenCalledTimes(2);
});
