import { describe, expect, it } from "vitest";
import {
  resolveWorkingDiffComparisonFromState,
  selectWorkingDiffComparisonInState,
  type WorkingDiffComparisonState,
  workingDiffComparisonKey,
} from "./state";

const checkout = { serverId: "server-1", workspaceId: "workspace-1", cwd: "/repo" };

function emptyState(): WorkingDiffComparisonState {
  return { overrides: {} };
}

describe("working diff comparison", () => {
  it("scopes selection to the workspace checkout rather than a panel", () => {
    expect(workingDiffComparisonKey(checkout)).toBe(
      "working-diff:server=server-1:workspace=workspace-1",
    );
    expect(workingDiffComparisonKey({ ...checkout, workspaceId: "workspace-2" })).not.toBe(
      workingDiffComparisonKey(checkout),
    );
    expect(workingDiffComparisonKey({ ...checkout, workspaceId: null, cwd: "/repo/" })).toBe(
      "working-diff:server=server-1:cwd=%2Frepo",
    );
  });

  it.each([true, false])("defaults to All changes when checkout dirtiness is %s", (isDirty) => {
    const status = { ...checkout, isDirty };
    expect(resolveWorkingDiffComparisonFromState(emptyState(), status)).toBe("all");
  });

  it.each(["all", "base", "uncommitted"] as const)(
    "keeps the selected %s comparison",
    (comparison) => {
      const selected = selectWorkingDiffComparisonInState(emptyState(), {
        ...checkout,
        comparison,
      });
      expect(resolveWorkingDiffComparisonFromState(selected, checkout)).toBe(comparison);
      expect(
        resolveWorkingDiffComparisonFromState(selected, { ...checkout, workspaceId: "other" }),
      ).toBe("all");
    },
  );
});
