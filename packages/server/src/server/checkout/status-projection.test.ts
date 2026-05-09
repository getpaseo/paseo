import { describe, expect, test } from "vitest";

import { CheckoutPrStatusSchema } from "../../shared/messages.js";
import { normalizeCheckoutPrStatusPayload } from "./status-projection.js";

describe("checkout status projection", () => {
  test("includes repository identity fields on the PR status wire payload", () => {
    const payload = normalizeCheckoutPrStatusPayload({
      number: 123,
      repoOwner: "internal-owner",
      repoName: "internal-repo",
      url: "https://github.com/getpaseo/paseo/pull/123",
      title: "Ship PR pane",
      state: "open",
      baseRefName: "main",
      headRefName: "feature/pr-pane",
      isMerged: false,
      isDraft: true,
      mergeable: "MERGEABLE",
      checks: [
        {
          name: "typecheck",
          status: "success",
          url: "https://github.com/getpaseo/paseo/actions/runs/1",
          workflow: "CI",
          duration: "1m 20s",
        },
      ],
      checksStatus: "success",
      reviewDecision: "approved",
    });

    expect(payload).toHaveProperty("repoOwner", "internal-owner");
    expect(payload).toHaveProperty("repoName", "internal-repo");
    expect(payload).toHaveProperty("mergeable", "MERGEABLE");
    expect(CheckoutPrStatusSchema.parse(payload)).toEqual(payload);
  });
});
