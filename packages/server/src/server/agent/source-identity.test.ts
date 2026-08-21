import baseline from "./fixtures/version-baseline.json" with { type: "json" };
import { expect, test } from "vitest";

import { verifyReviewedSourceIdentity } from "./source-identity.js";

test("fails closed unless installed daemon, package, and reviewed source identities match", () => {
  expect(verifyReviewedSourceIdentity(baseline, baseline)).toEqual({ allowed: true });
  expect(
    verifyReviewedSourceIdentity(baseline, { ...baseline, daemonVersion: "0.4.0-beta.1" }),
  ).toEqual({ allowed: false, reason: "source_identity_mismatch" });
  expect(verifyReviewedSourceIdentity(baseline, { ...baseline, sourceSha: null })).toEqual({
    allowed: false,
    reason: "source_identity_mismatch",
  });
});
