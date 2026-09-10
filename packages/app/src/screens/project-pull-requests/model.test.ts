import { describe, expect, it } from "vitest";
import type { ForgeSearchItem } from "@getpaseo/protocol/messages";
import { buildNewWorkspaceRoute } from "@/utils/host-routes";
import { pickerItemToCheckoutRequest } from "../new-workspace-picker-item";
import { parseInitialChangeRequest, serializeInitialChangeRequest } from "./model";

const pr: ForgeSearchItem = {
  kind: "change_request",
  forge: "github",
  number: 42,
  title: "Fix search & navigation",
  url: "https://github.com/acme/repo/pull/42",
  state: "OPEN",
  body: "Large PR body",
  labels: ["bug"],
  headRefName: "fix/search",
  baseRefName: "main",
};

describe("PR browser handoff", () => {
  it("preserves the project and PR checkout identity through the New Workspace route", () => {
    const route = buildNewWorkspaceRoute({
      serverId: "host",
      projectId: "project",
      sourceDirectory: "/repo with spaces",
      changeRequest: serializeInitialChangeRequest(pr),
    });
    const params = new URL(route, "https://paseo.test").searchParams;
    expect(params.get("dir")).toBe("/repo with spaces");
    expect(params.get("projectId")).toBe("project");
    const parsed = parseInitialChangeRequest(params.get("changeRequest"));
    expect(parsed).toEqual({ ...pr, body: null });
    expect(pickerItemToCheckoutRequest({ kind: "github-pr", item: parsed! })).toEqual({
      action: "checkout",
      refName: "fix/search",
      githubPrNumber: 42,
      checkoutSource: { kind: "change_request", forge: "github", number: 42 },
    });
  });
  it.each([
    undefined,
    "invalid",
    "{}",
    JSON.stringify({ ...pr, kind: "issue" }),
    JSON.stringify({ ...pr, number: -1 }),
  ])("ignores invalid route data: %s", (value) => {
    expect(parseInitialChangeRequest(value)).toBeUndefined();
  });
});
