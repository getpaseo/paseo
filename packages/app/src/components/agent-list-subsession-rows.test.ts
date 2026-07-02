import { describe, expect, it } from "vitest";
import type { AgentSubsessionPayload } from "@getpaseo/protocol/messages";
import { buildSubsessionRows } from "./agent-list-subsession-rows";

function sub(
  id: string,
  parentSessionId: string | null,
  status: AgentSubsessionPayload["status"] = "idle",
): AgentSubsessionPayload {
  return { id, title: id, status, parentSessionId };
}

describe("buildSubsessionRows", () => {
  it("returns an empty list for missing or empty subsessions", () => {
    expect(buildSubsessionRows(undefined)).toEqual([]);
    expect(buildSubsessionRows([])).toEqual([]);
  });

  it("renders direct children of the agent's root session at depth 1", () => {
    const rows = buildSubsessionRows([sub("a", "ses_root"), sub("b", "ses_root")]);
    expect(rows.map((r) => [r.sub.id, r.depth])).toEqual([
      ["a", 1],
      ["b", 1],
    ]);
  });

  it("nests subsessions under their parent subsession with increasing depth", () => {
    const rows = buildSubsessionRows([
      sub("child", "ses_root"),
      sub("grandchild", "child"),
      sub("sibling", "ses_root"),
    ]);
    expect(rows.map((r) => [r.sub.id, r.depth])).toEqual([
      ["child", 1],
      ["grandchild", 2],
      ["sibling", 1],
    ]);
  });

  it("renders every subsession exactly once even when parents form a cycle", () => {
    const rows = buildSubsessionRows([sub("a", "b"), sub("b", "a")]);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.sub.id)).size).toBe(2);
  });
});
