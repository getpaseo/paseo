import type { ViewStyle } from "react-native";
import { describe, expect, it } from "vitest";

import { buildDesktopFrameStyle } from "./combobox-frame-style";

function buildWidthStyle(input: {
  desktopMinWidth?: number;
  referenceWidth: number | null;
}): Pick<ViewStyle, "width" | "minWidth" | "maxWidth"> {
  const [frameStyle] = buildDesktopFrameStyle({
    desktopMinWidth: input.desktopMinWidth,
    desktopLockWidth: false,
    referenceWidth: input.referenceWidth,
    desktopFixedHeight: undefined,
    desktopPositionStyle: { left: 0, top: 0 },
    shouldHideDesktopContent: false,
    availableHeight: undefined,
  }) as ViewStyle[];

  return {
    width: frameStyle.width,
    minWidth: frameStyle.minWidth,
    maxWidth: frameStyle.maxWidth,
  };
}

describe("buildDesktopFrameStyle", () => {
  it("lets a narrow trigger grow to the default desktop ceiling", () => {
    expect(buildWidthStyle({ referenceWidth: 120 })).toEqual({
      width: undefined,
      minWidth: 120,
      maxWidth: 400,
    });
  });

  it("keeps a wide trigger from being capped below its own width", () => {
    expect(buildWidthStyle({ referenceWidth: 470 })).toEqual({
      width: undefined,
      minWidth: 470,
      maxWidth: 470,
    });
  });

  it("uses desktopMinWidth as an explicit floor raiser", () => {
    expect(buildWidthStyle({ desktopMinWidth: 360, referenceWidth: 120 })).toEqual({
      width: undefined,
      minWidth: 360,
      maxWidth: 400,
    });
  });

  it("keeps the trigger as the floor when it is wider than desktopMinWidth", () => {
    expect(buildWidthStyle({ desktopMinWidth: 240, referenceWidth: 300 })).toEqual({
      width: undefined,
      minWidth: 300,
      maxWidth: 400,
    });
  });

  it("locks the frame to its opening floor when content must not resize it", () => {
    const [frameStyle] = buildDesktopFrameStyle({
      desktopMinWidth: 360,
      desktopLockWidth: true,
      referenceWidth: 120,
      desktopFixedHeight: undefined,
      desktopPositionStyle: { left: 0, top: 0 },
      shouldHideDesktopContent: false,
      availableHeight: undefined,
    }) as ViewStyle[];

    expect(frameStyle).toMatchObject({ width: 360, minWidth: 360, maxWidth: 360 });
  });

  it("clamps a fixed height's minHeight and maxHeight to the available viewport height", () => {
    const styles = buildDesktopFrameStyle({
      desktopMinWidth: 440,
      desktopLockWidth: false,
      referenceWidth: 120,
      desktopFixedHeight: 400,
      desktopPositionStyle: { left: 0, top: 0 },
      shouldHideDesktopContent: false,
      availableHeight: 280,
    }) as Array<ViewStyle | null>;

    expect(styles[1]).toEqual({ minHeight: 280, maxHeight: 280 });
    expect(styles[4]).toBeNull();
  });

  it("keeps the requested fixed height when viewport space exceeds it", () => {
    const styles = buildDesktopFrameStyle({
      desktopMinWidth: 440,
      desktopLockWidth: false,
      referenceWidth: 120,
      desktopFixedHeight: 400,
      desktopPositionStyle: { left: 0, top: 0 },
      shouldHideDesktopContent: false,
      availableHeight: 600,
    }) as Array<ViewStyle | null>;

    expect(styles[1]).toEqual({ minHeight: 400, maxHeight: 400 });
    expect(styles[4]).toBeNull();
  });
});
