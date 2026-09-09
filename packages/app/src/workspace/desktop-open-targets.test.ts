import { describe, expect, it } from "vitest";
import { selectDesktopOpenTargets } from "./desktop-open-targets";

const cachedTargets = [
  {
    id: "vscode",
    label: "VS Code",
    kind: "editor" as const,
    icon: { kind: "symbol" as const, name: "terminal" as const },
  },
];

describe("selectDesktopOpenTargets", () => {
  it("hides cached targets when listing is unavailable", () => {
    expect(
      selectDesktopOpenTargets({
        canListTargets: false,
        targets: cachedTargets,
      }),
    ).toEqual([]);
  });

  it("returns cached targets when listing is available", () => {
    expect(
      selectDesktopOpenTargets({
        canListTargets: true,
        targets: cachedTargets,
      }),
    ).toEqual(cachedTargets);
  });
});
