import { describe, expect, it } from "vitest";
import {
  type BackPressSource,
  type BottomSheetController,
  createBottomSheetVisibilityTracker,
} from "./visibility-tracker";

interface FakeBottomSheetEvent {
  type: "present" | "dismiss";
}

class FakeBottomSheet implements BottomSheetController {
  events: FakeBottomSheetEvent[] = [];

  present(): void {
    this.events.push({ type: "present" });
  }

  dismiss(): void {
    this.events.push({ type: "dismiss" });
  }
}

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

  /** True when a sheet claimed the press, false when it falls through to the navigator. */
  press(): boolean {
    for (let index = this.listeners.length - 1; index >= 0; index--) {
      if (this.listeners[index]?.()) return true;
    }
    return false;
  }
}

function setup() {
  const sheet = new FakeBottomSheet();
  const backPress = new FakeBackPress();
  let closeCount = 0;
  const tracker = createBottomSheetVisibilityTracker({
    onClose: () => {
      closeCount += 1;
    },
    backPress,
  });
  return {
    sheet,
    backPress,
    tracker,
    closeCount: () => closeCount,
  };
}

/** Opens a sheet and runs it through the presentation the real sheet reports back. */
function openSheet(context: ReturnType<typeof setup>) {
  context.tracker.attachController(context.sheet);
  context.tracker.syncDesired({ visible: true });
  context.tracker.handleSheetIndexChange(0);
}

describe("bottom sheet visibility tracker", () => {
  it("presents once when the sheet becomes visible and dismisses when it goes back to hidden", () => {
    const { sheet, tracker } = setup();
    tracker.attachController(sheet);

    tracker.syncDesired({ visible: false });
    expect(sheet.events).toEqual([]);

    tracker.syncDesired({ visible: true });
    expect(sheet.events).toEqual([{ type: "present" }]);

    tracker.syncDesired({ visible: true });
    expect(sheet.events).toEqual([{ type: "present" }]);

    tracker.syncDesired({ visible: false });
    expect(sheet.events).toEqual([{ type: "present" }, { type: "dismiss" }]);
  });

  it("waits to present until the sheet controller becomes available", () => {
    const { sheet, tracker } = setup();
    tracker.syncDesired({ visible: true });
    expect(sheet.events).toEqual([]);

    tracker.attachController(sheet);
    expect(sheet.events).toEqual([{ type: "present" }]);
  });

  it("does not present while disabled", () => {
    const { sheet, tracker } = setup();
    tracker.attachController(sheet);

    tracker.syncDesired({ visible: true, isEnabled: false });
    expect(sheet.events).toEqual([]);
  });

  it("does not treat index -1 as a close because stacked sheets can be hidden without dismissing", () => {
    const { sheet, tracker, closeCount } = setup();
    tracker.attachController(sheet);
    tracker.syncDesired({ visible: true });

    tracker.handleSheetIndexChange(-1);
    expect(closeCount()).toBe(0);

    tracker.syncDesired({ visible: false });
    tracker.handleSheetIndexChange(-1);
    expect(closeCount()).toBe(0);
  });

  it("reports a dismiss while visible as a close request", () => {
    const { sheet, tracker, closeCount } = setup();
    tracker.attachController(sheet);
    tracker.syncDesired({ visible: true });

    tracker.handleSheetDismiss();

    expect(closeCount()).toBe(1);
  });

  it("reports close once when a hidden sheet is actually dismissed", () => {
    const { sheet, tracker, closeCount } = setup();
    tracker.attachController(sheet);
    tracker.syncDesired({ visible: true });

    tracker.handleSheetIndexChange(-1);
    tracker.handleSheetDismiss();

    expect(closeCount()).toBe(1);
  });

  it("allows a new close notification after re-presenting the sheet", () => {
    const { sheet, tracker, closeCount } = setup();
    tracker.attachController(sheet);
    tracker.syncDesired({ visible: true });

    tracker.handleSheetIndexChange(-1);
    tracker.handleSheetDismiss();
    expect(closeCount()).toBe(1);

    tracker.syncDesired({ visible: false });
    tracker.syncDesired({ visible: true });

    tracker.handleSheetIndexChange(-1);
    tracker.handleSheetDismiss();
    expect(closeCount()).toBe(2);
  });

  it("does not re-present when the controller reattaches before parent state acknowledges a user dismiss", () => {
    const { sheet, tracker, closeCount } = setup();
    tracker.attachController(sheet);
    tracker.syncDesired({ visible: true });

    tracker.handleSheetIndexChange(-1);
    tracker.attachController(null);
    tracker.attachController(sheet);

    expect(closeCount()).toBe(0);
    expect(sheet.events).toEqual([{ type: "present" }]);
  });

  it("does not re-present when dismiss fires before parent state acknowledges a user dismiss", () => {
    const { sheet, tracker, closeCount } = setup();
    tracker.attachController(sheet);
    tracker.syncDesired({ visible: true });

    tracker.handleSheetDismiss();
    tracker.attachController(null);
    tracker.attachController(sheet);

    expect(closeCount()).toBe(1);
    expect(sheet.events).toEqual([{ type: "present" }]);
  });

  it("allows a fresh open after parent state acknowledges a dismissed sheet", () => {
    const { sheet, tracker } = setup();
    tracker.attachController(sheet);
    tracker.syncDesired({ visible: true });

    tracker.handleSheetIndexChange(-1);
    tracker.attachController(null);
    tracker.attachController(sheet);
    tracker.syncDesired({ visible: false });
    tracker.syncDesired({ visible: true });

    expect(sheet.events).toEqual([{ type: "present" }, { type: "present" }]);
  });

  it("dismisses the sheet on a Back press instead of letting it reach the navigator", () => {
    const context = setup();
    openSheet(context);

    expect(context.backPress.press()).toBe(true);
    expect(context.sheet.events).toEqual([{ type: "present" }, { type: "dismiss" }]);
  });

  it("leaves Back to the navigator before the sheet is on screen and after it closes", () => {
    const context = setup();
    context.tracker.attachController(context.sheet);
    context.tracker.syncDesired({ visible: false });

    expect(context.backPress.press()).toBe(false);

    openSheet(context);
    context.tracker.handleSheetIndexChange(-1);
    context.tracker.handleSheetDismiss();

    expect(context.backPress.press()).toBe(false);
  });

  it("gives the Back press to the sheet presented last", () => {
    const backPress = new FakeBackPress();
    const sheets = ["below", "above"].map((name) => {
      const sheet = new FakeBottomSheet();
      const tracker = createBottomSheetVisibilityTracker({ onClose: () => {}, backPress });
      tracker.attachController(sheet);
      tracker.syncDesired({ visible: true });
      tracker.handleSheetIndexChange(0);
      return { name, sheet };
    });

    backPress.press();

    expect(sheets.map((entry) => [entry.name, entry.sheet.events.at(-1)?.type])).toEqual([
      ["below", "present"],
      ["above", "dismiss"],
    ]);
  });

  it("stops claiming Back once the sheet leaves the tree", () => {
    const context = setup();
    openSheet(context);
    context.tracker.attachController(null);

    expect(context.backPress.press()).toBe(false);
  });
});
