import { describe, expect, it } from "vitest";
import {
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

function setup() {
  const sheet = new FakeBottomSheet();
  let closeCount = 0;
  const tracker = createBottomSheetVisibilityTracker({
    onClose: () => {
      closeCount += 1;
    },
  });
  return {
    sheet,
    tracker,
    closeCount: () => closeCount,
  };
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
});
