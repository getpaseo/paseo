import { describe, expect, test } from "vitest";
import type { AgentPermissionRequest } from "./agent-sdk-types.js";
import {
  type PermissionChange,
  type PermissionLedger,
  TrackedPermissionMap,
} from "./tracked-permission-map.js";

function request(
  id: string,
  kind: AgentPermissionRequest["kind"] = "tool",
): AgentPermissionRequest {
  return { id, provider: "codex", name: "n", kind };
}

function tracked() {
  const changes: PermissionChange[] = [];
  const ledger: PermissionLedger = {
    agentId: "agent",
    generation: 0,
    notify: (change) => changes.push(change),
  };
  return { map: new TrackedPermissionMap(ledger, "inc-1"), ledger, changes };
}

describe("TrackedPermissionMap", () => {
  test("counts only real membership changes", () => {
    const { map, ledger } = tracked();
    map.set("a", request("a"));
    map.set("a", request("a"));
    expect(ledger.generation).toBe(1);
    map.delete("missing");
    expect(ledger.generation).toBe(1);
    map.delete("a");
    expect(ledger.generation).toBe(2);
  });

  test("replaceAll reconciles to the provider view and ignores unchanged rows", () => {
    const { map, ledger, changes } = tracked();
    map.replaceAll([request("a"), request("b", "question")]);
    const after = ledger.generation;
    map.replaceAll([request("a"), request("b", "question")]);
    expect(ledger.generation).toBe(after);
    map.replaceAll([request("b", "question")]);
    expect(changes.at(-1)).toMatchObject({ change: "resolved", requestId: "a", kind: "tool" });
    expect([...map.keys()]).toEqual(["b"]);
  });

  test("notifications carry the exact generation and incarnation", () => {
    const { map, changes } = tracked();
    map.set("q", request("q", "question"));
    expect(changes).toEqual([
      {
        agentId: "agent",
        sessionIncarnation: "inc-1",
        generation: 1,
        change: "requested",
        requestId: "q",
        kind: "question",
      },
    ]);
  });

  test("clear resolves every entry", () => {
    const { map, ledger } = tracked();
    map.set("a", request("a"));
    map.set("b", request("b"));
    map.clear();
    expect(map.size).toBe(0);
    expect(ledger.generation).toBe(4);
  });
});
