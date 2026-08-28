/**
 * @vitest-environment jsdom
 */
import React, { act, useCallback } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appToast = vi.hoisted(() => ({ show: vi.fn(), error: vi.fn() }));

vi.mock("@/contexts/toast-context", () => ({ useToast: () => appToast }));

import { useToast } from "./toast";

function Probe() {
  const toast = useToast();
  const showSaved = useCallback(() => toast.show("Saved", { variant: "success" }), [toast]);
  return (
    <button type="button" onClick={showSaved}>
      Save
    </button>
  );
}

describe("plugin React Native useToast", () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    appToast.show.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("delegates to Paseo's toast host", () => {
    act(() => root.render(<Probe />));
    act(() => container.querySelector("button")?.click());

    expect(appToast.show).toHaveBeenCalledWith("Saved", { variant: "success" });
  });
});
