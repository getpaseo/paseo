import { describe, expect, it } from "vitest";
import { buildWindowViewReport } from "./window-view-report";

describe("buildWindowViewReport", () => {
  it("sorts and dedupes both fields", () => {
    expect(
      buildWindowViewReport({
        visibleAgentIds: ["b", "a", "b"],
        visibleWorkspaceKeys: ["server-1:ws-2", "server-1:ws-1", "server-1:ws-2"],
      }),
    ).toEqual({
      visibleAgentIds: ["a", "b"],
      visibleWorkspaceKeys: ["server-1:ws-1", "server-1:ws-2"],
    });
  });

  it("reports no workspace keys while the sidebar is not actively reporting", () => {
    expect(buildWindowViewReport({ visibleAgentIds: [], visibleWorkspaceKeys: null })).toEqual({
      visibleAgentIds: [],
      visibleWorkspaceKeys: [],
    });
  });

  it("reports empty for an empty active sidebar the same as an inactive one", () => {
    expect(buildWindowViewReport({ visibleAgentIds: [], visibleWorkspaceKeys: [] })).toEqual({
      visibleAgentIds: [],
      visibleWorkspaceKeys: [],
    });
  });

  it("produces a deep-equal report for reordered, differently-deduped equivalent input", () => {
    const a = buildWindowViewReport({
      visibleAgentIds: ["agent-2", "agent-1"],
      visibleWorkspaceKeys: ["server-1:ws-2", "server-1:ws-1"],
    });
    const b = buildWindowViewReport({
      visibleAgentIds: ["agent-1", "agent-1", "agent-2"],
      visibleWorkspaceKeys: ["server-1:ws-1", "server-1:ws-2", "server-1:ws-1"],
    });
    expect(a).toEqual(b);
  });
});
