import { describe, expect, it } from "vitest";
import { type NestingAgent, selectNestedSubagentWorkspaceKeys } from "./nested-workspaces";

function agent(
  id: string,
  workspaceId: string,
  parent?: string,
  extra: Partial<NestingAgent> = {},
) {
  return {
    id,
    workspaceId,
    labels: parent ? { "paseo.parent-agent-id": parent } : {},
    ...extra,
  } satisfies NestingAgent;
}

function select(agents: NestingAgent[], openTabs: string[] = ["p"]) {
  const byId = new Map(agents.map((entry) => [entry.id, entry]));
  return selectNestedSubagentWorkspaceKeys({
    agentsByServerId: new Map([["s", byId]]),
    // A tab sits in its agent's workspace; "main" stands in for a parent the client has no record of.
    agentTabWorkspaceKeys: new Map(
      openTabs.map((id) => [`s:${id}`, `s:${byId.get(id)?.workspaceId ?? "main"}`]),
    ),
  });
}

describe("selectNestedSubagentWorkspaceKeys", () => {
  it("nests a workspace whose agents are all subagents of a parent elsewhere", () => {
    expect(
      select([agent("p", "main"), agent("a", "review"), agent("b", "review")].map(withParent)),
    ).toEqual(["s:review"]);
  });

  it("keeps a workspace that has an agent of its own", () => {
    expect(select([agent("p", "main"), agent("a", "review", "p"), agent("own", "review")])).toEqual(
      [],
    );
  });

  it("keeps a workspace whose parent has no open tab, so the child stays reachable", () => {
    expect(select([agent("p", "main"), agent("a", "review", "p")], [])).toEqual([]);
  });

  it("keeps a subagent sharing its parent's workspace, and ignores archived and background agents", () => {
    expect(select([agent("p", "main"), agent("a", "main", "p")])).toEqual([]);
    expect(
      select([
        agent("p", "main"),
        agent("a", "review", "p"),
        agent("old", "review", undefined, { archivedAt: new Date() }),
        agent("bg", "review", undefined, { background: true }),
      ]),
    ).toEqual(["s:review"]);
  });

  it("nests under a parent the client holds no record of, found through its open tab", () => {
    expect(select([agent("a", "review", "p")])).toEqual(["s:review"]);
  });

  it("keeps a workspace whose parent is archived or has no tab", () => {
    expect(
      select([
        agent("p", "main", undefined, { archivedAt: new Date() }),
        agent("a", "review", "p"),
      ]),
    ).toEqual([]);
    expect(select([agent("a", "review", "gone")])).toEqual([]);
  });

  it("nests one level deep: a grandchild's workspace stays when its parent's workspace nests", () => {
    expect(
      select(
        [agent("p", "main"), agent("c", "child", "p"), agent("g", "grandchild", "c")],
        ["p", "c"],
      ),
    ).toEqual(["s:child"]);
  });
});

function withParent(entry: NestingAgent): NestingAgent {
  return entry.id === "p" ? entry : { ...entry, labels: { "paseo.parent-agent-id": "p" } };
}
