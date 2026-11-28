import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopEditorBridge } from "@/desktop/host";
import {
  hasDesktopDefaultAppBridge,
  openInDesktopDefaultApp,
  selectDesktopOpenTargets,
} from "./desktop-open-targets";

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

describe("opening a file in the desktop default app", () => {
  afterEach(() => vi.unstubAllGlobals());

  function installDesktopEditorBridge(editor: DesktopEditorBridge) {
    vi.stubGlobal("window", { paseoDesktop: { editor } });
  }

  it("is unavailable on a desktop host that predates it", () => {
    installDesktopEditorBridge({ listTargets: async () => [], openTarget: async () => {} });

    expect(hasDesktopDefaultAppBridge()).toBe(false);
  });

  it("hands the path to the desktop host", async () => {
    const opened: string[] = [];
    installDesktopEditorBridge({
      openDefaultApp: async ({ path }) => {
        opened.push(path);
      },
    });

    expect(hasDesktopDefaultAppBridge()).toBe(true);
    await openInDesktopDefaultApp("/repo/report.csv");

    expect(opened).toEqual(["/repo/report.csv"]);
  });
});
