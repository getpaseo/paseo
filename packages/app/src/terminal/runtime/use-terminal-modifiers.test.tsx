// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useTerminalModifiers } from "./use-terminal-modifiers";

type ModifierApi = ReturnType<typeof useTerminalModifiers>;

let api: ModifierApi | null = null;
let container: HTMLDivElement | null = null;
let root: Root | null = null;

function Harness() {
  api = useTerminalModifiers();
  return null;
}

function getApi(): ModifierApi {
  if (!api) {
    throw new Error("useTerminalModifiers harness is not mounted");
  }
  return api;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<Harness />));
});

afterEach(() => {
  if (root && container) {
    act(() => root?.unmount());
    container.remove();
  }
  api = null;
  root = null;
  container = null;
});

describe("useTerminalModifiers", () => {
  it("publishes a toggled modifier before React rerenders", () => {
    const mountedApi = getApi();
    let immediateCtrl: boolean | null = null;

    act(() => {
      mountedApi.toggleModifier("ctrl");
      immediateCtrl = mountedApi.readModifiers().ctrl;
    });

    expect(immediateCtrl).toBe(true);
    expect(getApi().modifiers.ctrl).toBe(true);
  });

  it("clears the current modifier state synchronously", () => {
    const mountedApi = getApi();
    act(() => mountedApi.toggleModifier("ctrl"));
    const toggledApi = getApi();

    let immediateCtrl: boolean | null = null;
    act(() => {
      toggledApi.clearModifiers();
      immediateCtrl = toggledApi.readModifiers().ctrl;
    });

    expect(immediateCtrl).toBe(false);
    expect(getApi().modifiers.ctrl).toBe(false);
  });
});
