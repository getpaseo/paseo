import { describe, expect, it } from "vitest";
import { baseColors, PROJECT_ICON_COLORS } from "@/styles/theme";
import { deriveProjectIconColor, projectIconTextColor } from "./icon-colors";

describe("project icon colors", () => {
  it("derives a stable palette color", () => {
    const color = deriveProjectIconColor("project-a");

    expect(PROJECT_ICON_COLORS).toContain(color);
    expect(deriveProjectIconColor("project-a")).toBe(color);
  });

  it("chooses contrasting text colors", () => {
    expect(projectIconTextColor("#ffffff")).toBe(baseColors.black);
    expect(projectIconTextColor("#000000")).toBe(baseColors.white);
  });
});
