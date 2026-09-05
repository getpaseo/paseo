/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useWorkspacePinGroupDeleteAction } from "./delete-action";

async function confirmDelete(): Promise<boolean> {
  return true;
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("useWorkspacePinGroupDeleteAction", () => {
  it("disables duplicate deletion while a request is pending", async () => {
    const request = deferred();
    const execute = vi.fn(() => request.promise);
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useWorkspacePinGroupDeleteAction({
        enabled: true,
        confirm: confirmDelete,
        execute,
        onError,
      }),
    );

    let first!: Promise<void>;
    await act(async () => {
      first = result.current.run();
      await result.current.run();
    });

    expect(result.current.pending).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);

    await act(async () => {
      request.resolve();
      await first;
    });
    expect(result.current.pending).toBe(false);
    expect(onError).not.toHaveBeenCalled();
  });

  it("surfaces a rejected deletion and permits retry", async () => {
    const failure = new Error("group_not_found");
    const execute = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined);
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useWorkspacePinGroupDeleteAction({
        enabled: true,
        confirm: confirmDelete,
        execute,
        onError,
      }),
    );

    await act(async () => result.current.run());
    expect(onError).toHaveBeenCalledWith(failure);
    expect(result.current.pending).toBe(false);

    await act(async () => result.current.run());
    expect(execute).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(result.current.pending).toBe(false);
  });
});
