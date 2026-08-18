import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Pressable, Text } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerTrackPill, ComposerTrackRow } from "./tracks";

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));

/**
 * The real menu engine, in a real browser, because both things under test only exist there: the
 * panel's dismissal runs through `selectItem`, and the running mark is a Web Animations rotation
 * that jsdom cannot report.
 */

interface Mounted {
  root: Root;
  container: HTMLDivElement;
}

const mounted: Mounted[] = [];

function mount(node: ReactNode): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted.push({ root, container });
  return container;
}

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

function click(element: Element): void {
  act(() => {
    (element as HTMLElement).click();
  });
}

function pill(): HTMLElement {
  const trigger = document.querySelector('[data-testid="pill"]');
  if (!(trigger instanceof HTMLElement)) {
    throw new Error("track pill did not render");
  }
  return trigger;
}

function openPanel(): void {
  click(pill());
}

function row(testID: string): Element | null {
  return document.querySelector(`[data-testid="${testID}"]`);
}

function isPanelOpen(): boolean {
  return pill().getAttribute("aria-expanded") === "true";
}

describe("composer track panel", () => {
  it("dismisses itself when a row is chosen", () => {
    const onPress = vi.fn();
    mount(
      <ComposerTrackPill testID="pill" label="3 subagents" panelTitle="Subagents">
        <ComposerTrackRow accessibilityLabel="Subagent one" testID="row" onPress={onPress}>
          <Text>Subagent one</Text>
        </ComposerTrackRow>
      </ComposerTrackPill>,
    );

    openPanel();
    const target = row("row");
    expect(target).not.toBeNull();

    click(target as Element);

    expect(onPress).toHaveBeenCalledTimes(1);
    expect(isPanelOpen()).toBe(false);
    expect(row("row")).toBeNull();
  });

  it("stays open for a row whose result lands in the panel", () => {
    const onPress = vi.fn();
    mount(
      <ComposerTrackPill testID="pill" label="3 subagents" panelTitle="Subagents">
        <ComposerTrackRow
          accessibilityLabel="Archive finished"
          testID="row"
          closeOnSelect={false}
          onPress={onPress}
        >
          <Text>Archive finished</Text>
        </ComposerTrackRow>
      </ComposerTrackPill>,
    );

    openPanel();
    click(row("row") as Element);

    expect(onPress).toHaveBeenCalledTimes(1);
    expect(isPanelOpen()).toBe(true);
    expect(row("row")).not.toBeNull();
  });

  it("leaves the panel alone when a row's own action button is pressed", () => {
    const onPress = vi.fn();
    const onAction = vi.fn();
    mount(
      <ComposerTrackPill testID="pill" label="3 subagents" panelTitle="Subagents">
        <ComposerTrackRow accessibilityLabel="Subagent one" testID="row" onPress={onPress}>
          <Text>Subagent one</Text>
          <Pressable accessibilityRole="button" testID="row-archive" onPress={onAction}>
            <Text>Archive</Text>
          </Pressable>
        </ComposerTrackRow>
      </ComposerTrackPill>,
    );

    openPanel();
    click(row("row-archive") as Element);

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onPress).not.toHaveBeenCalled();
    expect(isPanelOpen()).toBe(true);
  });
});

describe("composer track pill status mark", () => {
  function mountMark(statusBucket: "running" | "failed"): HTMLElement {
    const container = mount(
      <ComposerTrackPill
        testID="pill"
        label="3 subagents"
        panelTitle="Subagents"
        statusBucket={statusBucket}
      >
        <Text>rows</Text>
      </ComposerTrackPill>,
    );
    const mark = container.querySelector('[data-testid="pill"] > div');
    if (!(mark instanceof HTMLElement)) {
      throw new Error("pill did not render a status mark");
    }
    return mark;
  }

  it("spins the shared ring while a child is running", () => {
    const mark = mountMark("running");
    const animated = [...mark.querySelectorAll("*")].filter(
      (element) => element.getAnimations().length > 0,
    );

    expect(animated).toHaveLength(1);
    // The rotation is on the carrier; the quarter arc it turns is the coloured top border inside.
    const arc = animated[0]?.firstElementChild as HTMLElement;
    const arcStyle = getComputedStyle(arc);
    expect(arcStyle.borderTopColor).toBe("rgb(38, 138, 224)");
    expect(arcStyle.borderLeftColor).toBe("rgba(0, 0, 0, 0)");
  });

  it("draws a still dot for every other state", () => {
    const mark = mountMark("failed");
    const animated = [...mark.querySelectorAll("*")].filter(
      (element) => element.getAnimations().length > 0,
    );

    expect(animated).toHaveLength(0);
    const dot = mark.firstElementChild as HTMLElement;
    expect(getComputedStyle(dot).backgroundColor).toBe("rgb(241, 46, 47)");
  });

  it("reserves one slot whatever the state, so the label never steps sideways", () => {
    const running = mountMark("running").getBoundingClientRect().width;
    const failed = mountMark("failed").getBoundingClientRect().width;

    expect(running).toBe(failed);
  });
});
