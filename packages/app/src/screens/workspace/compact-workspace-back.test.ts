import { describe, expect, it } from "vitest";
import type { BackPressSource } from "@/components/ui/isolated-bottom-sheet-modal/visibility-tracker";
import type { MobilePanelView } from "@/stores/panel-store";
import { subscribeCompactWorkspaceBack } from "./compact-workspace-back";

/**
 * Stands in for Android's `BackHandler`, which offers the press to listeners newest-first and
 * stops at the first one that claims it.
 */
class FakeBackPress implements BackPressSource {
  private listeners: (() => boolean)[] = [];

  subscribe(onBackPress: () => boolean): () => void {
    this.listeners.push(onBackPress);
    return () => {
      const index = this.listeners.indexOf(onBackPress);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  /** True when a listener claimed the press, false when Android handles it (leaving the app). */
  press(): boolean {
    for (let index = this.listeners.length - 1; index >= 0; index--) {
      if (this.listeners[index]?.()) return true;
    }
    return false;
  }
}

function setup(initial: MobilePanelView) {
  let panel = initial;
  const backPress = new FakeBackPress();
  const unsubscribe = subscribeCompactWorkspaceBack(backPress, {
    current: () => panel,
    show: (next) => {
      panel = next;
    },
  });
  return { backPress, unsubscribe, panel: () => panel };
}

describe("Android Back in a compact workspace", () => {
  it("opens the workspace list from a chat instead of leaving the app", () => {
    const workspace = setup("agent");

    expect(workspace.backPress.press()).toBe(true);
    expect(workspace.panel()).toBe("agent-list");
  });

  it("returns to the chat from the file explorer", () => {
    const workspace = setup("file-explorer");

    expect(workspace.backPress.press()).toBe(true);
    expect(workspace.panel()).toBe("agent");
  });

  it("leaves the app from the workspace list", () => {
    const workspace = setup("agent-list");

    expect(workspace.backPress.press()).toBe(false);
    expect(workspace.panel()).toBe("agent-list");
  });

  it("walks chat, list, then out of the app", () => {
    const workspace = setup("agent");

    expect(workspace.backPress.press()).toBe(true);
    expect(workspace.backPress.press()).toBe(false);
    expect(workspace.panel()).toBe("agent-list");
  });

  it("lets an overlay opened later close first", () => {
    const workspace = setup("agent");
    let sheetOpen = true;
    workspace.backPress.subscribe(() => {
      if (!sheetOpen) return false;
      sheetOpen = false;
      return true;
    });

    expect(workspace.backPress.press()).toBe(true);
    expect(sheetOpen).toBe(false);
    expect(workspace.panel()).toBe("agent");

    expect(workspace.backPress.press()).toBe(true);
    expect(workspace.panel()).toBe("agent-list");
  });

  it("stops handling Back once the workspace unsubscribes", () => {
    const workspace = setup("agent");
    workspace.unsubscribe();

    expect(workspace.backPress.press()).toBe(false);
    expect(workspace.panel()).toBe("agent");
  });
});
