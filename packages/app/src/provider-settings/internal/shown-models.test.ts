import { describe, expect, it } from "vitest";
import { arrangeShownFirst, countShownModels, toggleShownModel } from "./shown-models";

const models = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];

describe("toggleShownModel", () => {
  it("adds a model after the ones already picked, in the order the user checks them", () => {
    expect(toggleShownModel(["c"], "a")).toEqual(["c", "a"]);
  });

  it("removes a picked model and keeps the rest in order", () => {
    expect(toggleShownModel(["c", "a", "d"], "a")).toEqual(["c", "d"]);
  });
});

describe("arrangeShownFirst", () => {
  it("lists picked models first in picked order, then the rest in catalog order", () => {
    expect(arrangeShownFirst(models, ["d", "b"]).map((model) => model.id)).toEqual([
      "d",
      "b",
      "a",
      "c",
    ]);
  });

  it("skips picked models the catalog no longer has", () => {
    expect(arrangeShownFirst(models, ["gone", "c"]).map((model) => model.id)).toEqual([
      "c",
      "a",
      "b",
      "d",
    ]);
  });
});

describe("countShownModels", () => {
  it("counts only picked models the catalog still has", () => {
    expect(countShownModels(models, ["gone", "c", "a"])).toBe(2);
  });
});
