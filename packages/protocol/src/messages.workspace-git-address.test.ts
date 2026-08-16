import { expect, test } from "vitest";
import { CheckoutForgeGetCheckDetailsRequestSchema, CheckoutStatusRequestSchema } from "./messages";

test.each(["", "   "])(
  "Git request schemas accept omitted legacy identity but reject selected identity %j",
  (workspaceId) => {
    expect(
      CheckoutStatusRequestSchema.safeParse({
        type: "checkout_status_request",
        cwd: "/legacy",
        requestId: "legacy",
      }).success,
    ).toBe(true);
    expect(
      CheckoutStatusRequestSchema.safeParse({
        type: "checkout_status_request",
        workspaceId,
        cwd: "/shared",
        requestId: "selected",
      }).success,
    ).toBe(false);
    expect(
      CheckoutForgeGetCheckDetailsRequestSchema.safeParse({
        type: "checkout.forge.get_check_details.request",
        workspaceId,
        cwd: "/shared",
        checkRunId: 1,
        requestId: "check",
      }).success,
    ).toBe(false);
  },
);

test.each(["", "   "])("selected Git request schemas reject cwd %j", (cwd) => {
  expect(
    CheckoutStatusRequestSchema.safeParse({
      type: "checkout_status_request",
      workspaceId: "workspace-a",
      cwd,
      requestId: "selected",
    }).success,
  ).toBe(false);
});

test("selected Git request schemas normalize a valid cwd", () => {
  expect(
    CheckoutStatusRequestSchema.parse({
      type: "checkout_status_request",
      workspaceId: " workspace-a ",
      cwd: " /shared ",
      requestId: "selected",
    }),
  ).toMatchObject({ workspaceId: "workspace-a", cwd: "/shared" });
});
