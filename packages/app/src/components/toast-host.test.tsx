// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useToastHost } from "./toast-host";

describe("useToastHost", () => {
  it("dismisses the toast that show returned the dismiss for", () => {
    const { result } = renderHook(() => useToastHost());

    let dismiss = () => {};
    act(() => {
      dismiss = result.current.api.show("Uploading image…", { durationMs: null });
    });
    expect(result.current.toast?.content).toBe("Uploading image…");

    act(() => dismiss());
    expect(result.current.toast).toBeNull();
  });

  it("leaves a newer toast in place when an older one is dismissed", () => {
    const { result } = renderHook(() => useToastHost());

    let dismissUploading = () => {};
    act(() => {
      dismissUploading = result.current.api.show("Uploading image…", { durationMs: null });
    });
    act(() => {
      result.current.api.show("Image uploaded", { variant: "success" });
    });

    act(() => dismissUploading());
    expect(result.current.toast?.content).toBe("Image uploaded");
  });

  it("ends each toast's undo opportunity once, including replacement", () => {
    const { result } = renderHook(() => useToastHost());
    const dismissed: string[] = [];
    let dismissFirst = () => {};
    let dismissSecond = () => {};
    act(() => {
      dismissFirst = result.current.api.show("First archive", {
        onDismiss: () => dismissed.push("first"),
      });
    });
    act(() => {
      dismissSecond = result.current.api.show("Second archive", {
        onDismiss: () => dismissed.push("second"),
      });
    });
    expect(dismissed).toEqual(["first"]);
    act(() => dismissFirst());
    expect(result.current.toast?.content).toBe("Second archive");
    expect(dismissed).toEqual(["first"]);
    act(() => {
      dismissSecond();
      dismissSecond();
      result.current.dismiss();
    });
    expect(result.current.toast).toBeNull();
    expect(dismissed).toEqual(["first", "second"]);
  });
});
