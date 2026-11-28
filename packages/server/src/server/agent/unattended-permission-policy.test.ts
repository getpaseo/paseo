import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { describe, expect, test } from "vitest";
import {
  buildUnattendedHubPermissionDenyResponse,
  isUnattendedHubExecutionAgent,
  UNATTENDED_HUB_PERMISSION_DENY_MESSAGE,
  type UnattendedPermissionPolicyAgent,
} from "./unattended-permission-policy.js";

const HUB_OWNER = {
  kind: "daemon" as const,
  daemonId: "daemon-1",
  executionId: "exec-1",
};

describe("unattended Hub permission policy", () => {
  test("matches a root Hub-dispatched agent without looking up parents", async () => {
    let lookups = 0;
    const result = await isUnattendedHubExecutionAgent({ id: "hub-root", owner: HUB_OWNER }, () => {
      lookups += 1;
      return null;
    });

    expect(result).toBe(true);
    expect(lookups).toBe(0);
  });

  test("matches direct and nested descendant subagents of a Hub-dispatched agent", async () => {
    const agents = new Map<string, UnattendedPermissionPolicyAgent>([
      ["hub-root", { id: "hub-root", owner: HUB_OWNER }],
      ["child", { id: "child", labels: { [PARENT_AGENT_ID_LABEL]: "hub-root" } }],
      ["grandchild", { id: "grandchild", labels: { [PARENT_AGENT_ID_LABEL]: "child" } }],
    ]);

    const lookup = async (agentId: string) => agents.get(agentId) ?? null;

    await expect(isUnattendedHubExecutionAgent(agents.get("child")!, lookup)).resolves.toBe(true);
    await expect(isUnattendedHubExecutionAgent(agents.get("grandchild")!, lookup)).resolves.toBe(
      true,
    );
  });

  test("does not match interactive root agents or their descendant subagents", async () => {
    const agents = new Map<string, UnattendedPermissionPolicyAgent>([
      ["user-root", { id: "user-root", labels: {} }],
      ["user-child", { id: "user-child", labels: { [PARENT_AGENT_ID_LABEL]: "user-root" } }],
    ]);

    const lookup = (agentId: string) => agents.get(agentId) ?? null;

    await expect(isUnattendedHubExecutionAgent(agents.get("user-root")!, lookup)).resolves.toBe(
      false,
    );
    await expect(isUnattendedHubExecutionAgent(agents.get("user-child")!, lookup)).resolves.toBe(
      false,
    );
  });

  test("terminates cleanly on cyclic or missing parent references", async () => {
    const agents = new Map<string, UnattendedPermissionPolicyAgent>([
      ["a", { id: "a", labels: { [PARENT_AGENT_ID_LABEL]: "b" } }],
      ["b", { id: "b", labels: { [PARENT_AGENT_ID_LABEL]: "a" } }],
      ["orphan", { id: "orphan", labels: { [PARENT_AGENT_ID_LABEL]: "missing" } }],
    ]);

    const lookup = (agentId: string) => agents.get(agentId) ?? null;

    await expect(isUnattendedHubExecutionAgent(agents.get("a")!, lookup)).resolves.toBe(false);
    await expect(isUnattendedHubExecutionAgent(agents.get("orphan")!, lookup)).resolves.toBe(false);
  });

  test("builds a non-interrupting deny response with actionable unattended guidance", () => {
    const response = buildUnattendedHubPermissionDenyResponse();

    expect(response).toEqual({
      behavior: "deny",
      message: UNATTENDED_HUB_PERMISSION_DENY_MESSAGE,
    });
    expect(response.behavior).toBe("deny");
    if (response.behavior !== "deny") {
      throw new Error("Expected deny response");
    }
    expect(response.interrupt).toBeUndefined();
    expect(response.message).toContain("no person present");
    expect(response.message).toMatch(/rewrite|replace/i);
  });
});
