import { describe, expect, it } from "vitest";
import type { ForgeSearchItem } from "@getpaseo/protocol/messages";
import type { CheckoutStatusPayload } from "@/git/checkout-status-cache";
import {
  pickerItemToCheckoutRequest,
  resolveCheckoutRequest,
  type PickerItem,
} from "./new-workspace-picker-item";

const prItem: ForgeSearchItem = {
  kind: "change_request",
  number: 42,
  title: "Add picker",
  url: "https://example.com/pull/42",
  state: "open",
  body: null,
  labels: [],
  baseRefName: "main",
  headRefName: "feature/picker",
};

describe("pickerItemToCheckoutRequest", () => {
  it("returns undefined for no selection (null)", () => {
    expect(pickerItemToCheckoutRequest(null)).toBeUndefined();
  });

  it("maps a branch row to branch-off with the branch name", () => {
    const item: PickerItem = { kind: "branch", name: "dev" };
    expect(pickerItemToCheckoutRequest(item)).toEqual({
      action: "branch-off",
      refName: "dev",
    });
  });

  it("maps a github-pr row to checkout using the head ref and pr number", () => {
    const item: PickerItem = {
      kind: "github-pr",
      item: prItem,
    };
    expect(pickerItemToCheckoutRequest(item)).toEqual({
      action: "checkout",
      refName: "feature/picker",
      checkoutSource: { kind: "change_request", forge: "github", number: 42 },
      githubPrNumber: 42,
    });
  });

  it("handles a github-pr with a null baseRef", () => {
    const item: PickerItem = {
      kind: "github-pr",
      item: {
        ...prItem,
        number: 7,
        title: "Orphan branch",
        baseRefName: null,
        headRefName: "orphan",
      },
    };
    expect(pickerItemToCheckoutRequest(item)).toEqual({
      action: "checkout",
      refName: "orphan",
      checkoutSource: { kind: "change_request", forge: "github", number: 7 },
      githubPrNumber: 7,
    });
  });

  it("does not send the legacy githubPrNumber for non-GitHub change requests", () => {
    const item: PickerItem = {
      kind: "github-pr",
      item: {
        ...prItem,
        forge: "gitlab",
        number: 21,
        projectPath: "acme/repo",
        url: "https://gitlab.example.com/acme/repo/-/merge_requests/21",
      },
    };
    expect(pickerItemToCheckoutRequest(item)).toEqual({
      action: "checkout",
      refName: "feature/picker",
      checkoutSource: {
        kind: "change_request",
        forge: "gitlab",
        number: 21,
        projectPath: "acme/repo",
      },
    });
  });
});

describe("resolveCheckoutRequest", () => {
  const checkoutStatus = {
    currentBranch: "feature/current",
  } as CheckoutStatusPayload;

  it("branches from the loaded current branch when nothing was picked", () => {
    expect(resolveCheckoutRequest(null, checkoutStatus)).toEqual({
      action: "branch-off",
      refName: "feature/current",
    });
  });

  it("prefers an explicit picker selection", () => {
    expect(
      resolveCheckoutRequest({ kind: "branch", name: "feature/picked" }, checkoutStatus),
    ).toEqual({
      action: "branch-off",
      refName: "feature/picked",
    });
  });

  it("preserves the server-default intent for a detached checkout", () => {
    expect(
      resolveCheckoutRequest(null, { ...checkoutStatus, currentBranch: null }),
    ).toBeUndefined();
  });
});
