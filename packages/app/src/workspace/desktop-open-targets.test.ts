import { describe, expect, it } from "vitest";
import { selectDesktopOpenTargets } from "./desktop-open-targets";

const vscode = {
  id: "vscode",
  label: "VS Code",
  kind: "editor" as const,
  icon: { kind: "symbol" as const, name: "terminal" as const },
  remoteDestinationKinds: ["ssh"] as const,
};

const finder = {
  id: "finder",
  label: "Finder",
  kind: "file-manager" as const,
  icon: { kind: "symbol" as const, name: "folder" as const },
  remoteDestinationKinds: [] as const,
};

const cachedTargets = [vscode, finder];

describe("selectDesktopOpenTargets", () => {
  it("hides cached targets when listing is unavailable", () => {
    expect(
      selectDesktopOpenTargets({
        execution: null,
        targets: cachedTargets,
      }),
    ).toEqual([]);
  });

  it("returns cached targets when listing is available", () => {
    expect(
      selectDesktopOpenTargets({
        execution: { kind: "local" },
        targets: cachedTargets,
      }),
    ).toEqual(cachedTargets);
  });

  it("offers only remote-capable targets when the daemon is reached through an authority", () => {
    expect(
      selectDesktopOpenTargets({
        execution: { kind: "remote", destination: { kind: "ssh", host: "dev" } },
        targets: cachedTargets,
      }),
    ).toEqual([vscode]);
  });

  it("still reports remote-capable targets while no authority is configured", () => {
    // The setup entry may only be offered when an editor that could use it is installed.
    expect(
      selectDesktopOpenTargets({
        execution: { kind: "remote-unconfigured" },
        targets: cachedTargets,
      }),
    ).toEqual([vscode]);
    expect(
      selectDesktopOpenTargets({
        execution: { kind: "remote-unconfigured" },
        targets: [finder],
      }),
    ).toEqual([]);
  });
});
