import type { TFunction } from "i18next";
import { Scan } from "lucide-react-native";
import { describe, expect, it } from "vitest";
import { describeControl, type ComposerControlItem } from "./composer-control";
import { toFeatureItem } from "./control-items";

const t = ((key: string) => key) as unknown as TFunction;

const base = { id: "x", title: "Context", icon: Scan };

const select: ComposerControlItem = {
  ...base,
  type: "select",
  value: "large",
  choices: [
    { value: "small", label: "Small" },
    { value: "large", label: "Large", description: "More room" },
  ],
  onChange: () => {},
};

describe("describeControl", () => {
  it("shows the chosen label and opens a list for a select", () => {
    expect(describeControl(select, "toolbar", t)).toMatchObject({
      value: "Large",
      selectedId: "large",
      iconOnly: false,
      tooltip: "Context",
      opensList: true,
      options: [
        { id: "small", label: "Small" },
        { id: "large", label: "Large", description: "More room" },
      ],
    });
  });

  it("names the choice in the tooltip of an icon-only select", () => {
    const item: ComposerControlItem = { ...select, iconOnly: true } as ComposerControlItem;
    expect(describeControl(item, "toolbar", t)).toMatchObject({
      iconOnly: true,
      tooltip: "Context: Large",
    });
  });

  it("toggles on press in the toolbar and lists on/off in the sheet", () => {
    const toggle: ComposerControlItem = {
      ...base,
      type: "toggle",
      value: true,
      onChange: () => {},
    };
    expect(describeControl(toggle, "toolbar", t).opensList).toBe(false);
    const inSheet = describeControl(toggle, "sheet", t);
    expect(inSheet).toMatchObject({ opensList: true, selectedId: "true" });
    expect(inSheet.value).toBe("agentControls.features.on");
  });

  it("acts on press for an action in both places", () => {
    const action: ComposerControlItem = { ...base, type: "action", onPress: () => {} };
    expect(describeControl(action, "toolbar", t).opensList).toBe(false);
    expect(describeControl(action, "sheet", t).opensList).toBe(false);
  });
});

describe("toFeatureItem", () => {
  it("reads a toggle from the agent's options and writes its key", () => {
    const writes: Array<[string, unknown]> = [];
    const item = toFeatureItem(
      { type: "toggle", key: "fast_mode", label: "Fast", defaultValue: false },
      { controls: [], options: { fast_mode: true }, onSetOption: (k, v) => writes.push([k, v]) },
    );
    expect(item).toMatchObject({
      id: "feature-fast_mode",
      type: "toggle",
      value: true,
      highlight: "yellow",
      testID: "agent-feature-fast_mode",
    });
    if (item.type === "toggle") item.onChange(false);
    expect(writes).toEqual([["fast_mode", false]]);
  });

  it("falls back to the default choice and shows only the icon when asked", () => {
    const item = toFeatureItem(
      {
        type: "select",
        key: "speed",
        label: "Speed",
        desktopTrigger: "icon",
        defaultValue: "standard",
        choices: [
          { value: "standard", label: "Standard" },
          { value: "fast", label: "Fast" },
        ],
      },
      { controls: [], options: {}, onSetOption: () => {} },
    );
    expect(item).toMatchObject({ type: "select", value: "standard", iconOnly: true });
    expect(item.highlight).toBeUndefined();
  });
});
