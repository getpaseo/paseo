import { describe, expect, it } from "vitest";
import {
  closeSubPage,
  currentPageId,
  goBack,
  isSubPageOpen,
  MENU_ROOT_PATH,
  openSubPage,
} from "./menu-navigation";

describe("openSubPage", () => {
  it("opens a submenu from the root", () => {
    expect(openSubPage(MENU_ROOT_PATH, { id: "show", depth: 0 })).toEqual(["show"]);
  });

  it("nests a submenu opened from inside another", () => {
    expect(openSubPage(["show"], { id: "colors", depth: 1 })).toEqual(["show", "colors"]);
  });

  it("swaps branches instead of nesting when the trigger is a sibling", () => {
    // Sliding the pointer from one root trigger to another must not stack both flyouts.
    expect(openSubPage(["grouping"], { id: "show", depth: 0 })).toEqual(["show"]);
  });

  it("drops deeper pages when an ancestor's sibling opens", () => {
    expect(openSubPage(["show", "colors"], { id: "grouping", depth: 0 })).toEqual(["grouping"]);
  });

  it("returns the same path when the submenu is already open", () => {
    const path = ["show"];
    expect(openSubPage(path, { id: "show", depth: 0 })).toBe(path);
  });
});

describe("closeSubPage", () => {
  it("closes the page at a depth and everything below it", () => {
    expect(closeSubPage(["show", "colors"], 0)).toEqual([]);
    expect(closeSubPage(["show", "colors"], 1)).toEqual(["show"]);
  });

  it("returns the same path when nothing is open at that depth", () => {
    const path = ["show"];
    expect(closeSubPage(path, 1)).toBe(path);
    expect(closeSubPage(MENU_ROOT_PATH, 0)).toBe(MENU_ROOT_PATH);
  });
});

describe("goBack", () => {
  it("pops one page", () => {
    expect(goBack(["show", "colors"])).toEqual(["show"]);
    expect(goBack(["show"])).toEqual([]);
  });

  it("is a no-op at the root", () => {
    expect(goBack(MENU_ROOT_PATH)).toBe(MENU_ROOT_PATH);
  });
});

describe("currentPageId", () => {
  it("is null at the root and the last id otherwise", () => {
    expect(currentPageId(MENU_ROOT_PATH)).toBeNull();
    expect(currentPageId(["show", "colors"])).toBe("colors");
  });
});

describe("isSubPageOpen", () => {
  it("matches on id and depth together", () => {
    const path = ["show", "colors"];
    expect(isSubPageOpen(path, { id: "show", depth: 0 })).toBe(true);
    expect(isSubPageOpen(path, { id: "colors", depth: 1 })).toBe(true);
    // Right id, wrong level — a different trigger that happens to share a name.
    expect(isSubPageOpen(path, { id: "colors", depth: 0 })).toBe(false);
    expect(isSubPageOpen(path, { id: "grouping", depth: 0 })).toBe(false);
  });
});
