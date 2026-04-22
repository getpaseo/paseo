import { describe, expect, it } from "vitest";
import { buildAgentLsFetchOptions } from "./ls.js";

describe("buildAgentLsFetchOptions", () => {
  it("fetches active agents by default", () => {
    expect(buildAgentLsFetchOptions({})).toEqual({
      scope: "active",
    });
  });

  it("keeps label and thinking filters within the active scope", () => {
    expect(
      buildAgentLsFetchOptions({
        label: ["surface=workspace"],
        thinking: " medium ",
      }),
    ).toEqual({
      scope: "active",
      filter: {
        labels: { surface: "workspace" },
        thinkingOptionId: "medium",
      },
    });
  });

  it("uses the unscoped archived query for -a", () => {
    expect(buildAgentLsFetchOptions({ all: true })).toEqual({
      filter: {
        includeArchived: true,
      },
    });
  });
});
