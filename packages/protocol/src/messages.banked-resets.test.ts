import { expect, test } from "vitest";
import {
  ProviderUsageSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";

const legacyUsage = {
  providerId: "codex",
  displayName: "Codex",
  status: "available",
  planLabel: "Pro",
  windows: [],
};

test("usage without banked resets remains valid", () => {
  expect(ProviderUsageSchema.parse(legacyUsage)).toEqual(legacyUsage);
});

test("banked reset metadata preserves unknown future statuses and types", () => {
  const usage = {
    ...legacyUsage,
    bankedResets: {
      availableCount: 1,
      error: null,
      credits: [
        {
          id: "reset-1",
          resetType: "future_type",
          supportedByPlan: false,
          status: "future_status",
          grantedAt: "2026-09-01T00:00:00Z",
          expiresAt: null,
          title: null,
          description: null,
        },
      ],
    },
  };
  expect(ProviderUsageSchema.parse(usage)).toEqual(usage);
});

test("banked reset RPCs parse and reject empty redemption identifiers", () => {
  const request = {
    type: "provider.codex.consume_banked_reset.request",
    requestId: "request-1",
    creditId: "reset-1",
    idempotencyKey: "attempt-1",
  };
  expect(SessionInboundMessageSchema.parse(request)).toEqual(request);
  expect(SessionInboundMessageSchema.safeParse({ ...request, creditId: "" }).success).toBe(false);
  expect(SessionInboundMessageSchema.safeParse({ ...request, idempotencyKey: "" }).success).toBe(
    false,
  );
  const response = {
    type: "provider.codex.consume_banked_reset.response",
    payload: { requestId: "request-1", outcome: "reset" },
  };
  expect(SessionOutboundMessageSchema.parse(response)).toEqual(response);
});
