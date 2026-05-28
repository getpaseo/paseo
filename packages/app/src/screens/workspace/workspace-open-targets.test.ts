import { describe, expect, it } from "vitest";
import { filterTargetsForDaemonLocation } from "./workspace-open-targets";

describe("filterTargetsForDaemonLocation", () => {
  const targets = [
    { id: "cursor", requiresLocalDaemon: true },
    { id: "vscode", requiresLocalDaemon: true },
    { id: "github", requiresLocalDaemon: false },
  ];

  it("keeps local app targets and URL targets for the local daemon", () => {
    expect(filterTargetsForDaemonLocation(targets, { isLocalDaemon: true })).toEqual(targets);
  });

  it("hides local app targets for a remote daemon", () => {
    expect(filterTargetsForDaemonLocation(targets, { isLocalDaemon: false })).toEqual([
      { id: "github", requiresLocalDaemon: false },
    ]);
  });

  it("preserves target order after filtering", () => {
    expect(
      filterTargetsForDaemonLocation(
        [
          { id: "github", requiresLocalDaemon: false },
          { id: "finder", requiresLocalDaemon: true },
          { id: "docs", requiresLocalDaemon: false },
        ],
        { isLocalDaemon: false },
      ),
    ).toEqual([
      { id: "github", requiresLocalDaemon: false },
      { id: "docs", requiresLocalDaemon: false },
    ]);
  });
});
