import { describe, expect, it } from "vitest";
import { Brain } from "lucide-react-native";
import type { ComposerControlChoice, ComposerControlItem } from "./composer-control";
import { classifySheetControl, layoutSheetHome } from "./sheet-control-layout";

function noop() {}

function choices(...labels: string[]): ComposerControlChoice[] {
  return labels.map((label) => ({ value: label.toLowerCase(), label }));
}

function select(
  id: string,
  options: {
    choices: ComposerControlChoice[];
    searchable?: boolean;
    remoteSearch?: boolean;
  },
): ComposerControlItem {
  return {
    id,
    type: "select",
    title: id,
    icon: Brain,
    value: options.choices[0]?.value ?? null,
    onChange: noop,
    ...options,
  };
}

function toggle(id: string): ComposerControlItem {
  return { id, type: "toggle", title: id, icon: Brain, value: false, onChange: noop };
}

function action(id: string): ComposerControlItem {
  return { id, type: "action", title: id, icon: Brain, onPress: noop };
}

const claudeThinking = select("thinking", {
  choices: choices("Off", "Low", "Medium", "High", "Extra High", "Max"),
});

describe("classifySheetControl", () => {
  it("draws a toggle as a switch row", () => {
    expect(classifySheetControl(toggle("fast"))).toBe("switch");
  });

  it("draws an action as a row", () => {
    expect(classifySheetControl(action("open"))).toBe("action");
  });

  it("draws a short select of short labels as pills", () => {
    expect(classifySheetControl(claudeThinking)).toBe("pills");
  });

  it("draws a select as a radio list once a label is too long for a pill", () => {
    expect(
      classifySheetControl(select("mode", { choices: choices("Default", "Accept file edits") })),
    ).toBe("radioList");
  });

  it("draws a select as a radio list when any choice has a description", () => {
    expect(
      classifySheetControl(
        select("speed", {
          choices: [
            { value: "normal", label: "Normal" },
            { value: "fast", label: "Fast", description: "Costs more" },
          ],
        }),
      ),
    ).toBe("radioList");
  });

  it("keeps seven choices inline and moves an eighth to its own page", () => {
    const seven = choices("A", "B", "C", "D", "E", "F", "G");
    expect(classifySheetControl(select("seven", { choices: seven }))).toBe("pills");
    expect(classifySheetControl(select("eight", { choices: [...seven, ...choices("H")] }))).toBe(
      "subpage",
    );
  });

  it("moves a searchable select to its own page whatever its size", () => {
    expect(
      classifySheetControl(select("branch", { choices: choices("main"), searchable: true })),
    ).toBe("subpage");
    expect(
      classifySheetControl(select("issue", { choices: choices("one"), remoteSearch: true })),
    ).toBe("subpage");
  });
});

describe("layoutSheetHome", () => {
  it("orders thinking, then inline selects, then one card of rows, then mode", () => {
    const speed = select("speed", { choices: choices("Normal", "Flex", "Fast", "Ultrafast") });
    const blocks = layoutSheetHome({
      thinkingItems: [claudeThinking],
      featureItems: [toggle("plan"), speed, action("review")],
      modeChoiceCount: 3,
    });
    expect(blocks.map((block) => block.kind)).toEqual(["pills", "pills", "rows", "mode"]);
    expect(blocks[2]).toMatchObject({
      kind: "rows",
      rows: [
        { layout: "switch", item: { id: "plan" } },
        { layout: "action", item: { id: "review" } },
      ],
    });
    expect(blocks[3]).toEqual({ kind: "mode", layout: "radioList" });
  });

  it("puts a select that needs its own page in the card of rows", () => {
    const branch = select("branch", { choices: choices("main"), searchable: true });
    expect(
      layoutSheetHome({ thinkingItems: [], featureItems: [branch], modeChoiceCount: 0 }),
    ).toEqual([{ kind: "rows", rows: [{ layout: "subpage", item: branch }] }]);
  });

  it("moves a long mode list to its own page", () => {
    expect(layoutSheetHome({ thinkingItems: [], featureItems: [], modeChoiceCount: 8 })).toEqual([
      { kind: "mode", layout: "subpage" },
    ]);
  });
});
