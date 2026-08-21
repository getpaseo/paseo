import { describe, expect, test } from "vitest";
import { z } from "zod";

import {
  CheckoutDiffUpdateSchema,
  ServerInfoStatusPayloadSchema,
  SubscribeCheckoutDiffResponseSchema,
} from "./messages.js";

const LegacyParsedDiffFileSchema = z.object({
  path: z.string(),
  isNew: z.boolean(),
  isDeleted: z.boolean(),
  additions: z.number(),
  deletions: z.number(),
  hunks: z.array(z.unknown()),
});

const LegacySubscribeCheckoutDiffResponseSchema = z.object({
  type: z.literal("subscribe_checkout_diff_response"),
  payload: z.object({
    subscriptionId: z.string(),
    cwd: z.string(),
    files: z.array(LegacyParsedDiffFileSchema),
    error: z.unknown().nullable(),
    requestId: z.string(),
  }),
});

const submoduleFile = {
  path: "modules/service/src/service.ts",
  submodulePath: "modules/service",
  isNew: false,
  isDeleted: false,
  additions: 4,
  deletions: 2,
  hunks: [],
};

describe("checkout diff submodule schemas", () => {
  test("parses submodule metadata and tagged files in subscription responses", () => {
    const parsed = SubscribeCheckoutDiffResponseSchema.parse({
      type: "subscribe_checkout_diff_response",
      payload: {
        subscriptionId: "diff-1",
        cwd: "/tmp/repo",
        files: [submoduleFile],
        submodules: [
          {
            path: "modules/service",
            branch: "feature/submodule-status",
            currentSha: "1111111111111111111111111111111111111111",
            basePinnedSha: "2222222222222222222222222222222222222222",
            headPinnedSha: "3333333333333333333333333333333333333333",
            checkoutState: "initialized",
            changeState: "pointer_changed",
          },
        ],
        error: null,
        requestId: "request-1",
      },
    });

    expect(parsed.payload.files[0]?.submodulePath).toBe("modules/service");
    expect(parsed.payload.submodules).toEqual([
      {
        path: "modules/service",
        branch: "feature/submodule-status",
        currentSha: "1111111111111111111111111111111111111111",
        basePinnedSha: "2222222222222222222222222222222222222222",
        headPinnedSha: "3333333333333333333333333333333333333333",
        checkoutState: "initialized",
        changeState: "pointer_changed",
      },
    ]);
  });

  test("accepts detached and unavailable submodules plus future state names", () => {
    const parsed = CheckoutDiffUpdateSchema.parse({
      type: "checkout_diff_update",
      payload: {
        subscriptionId: "diff-1",
        cwd: "/tmp/repo",
        files: [],
        submodules: [
          {
            path: "modules/unavailable",
            branch: null,
            currentSha: null,
            headPinnedSha: null,
            checkoutState: "future_checkout_state",
            changeState: "future_change_state",
          },
        ],
        error: null,
      },
    });

    expect(parsed.payload.submodules?.[0]).toEqual({
      path: "modules/unavailable",
      branch: null,
      currentSha: null,
      headPinnedSha: null,
      checkoutState: "future_checkout_state",
      changeState: "future_change_state",
    });
  });

  test("new clients still parse checkout diffs from daemons without submodule metadata", () => {
    const parsed = SubscribeCheckoutDiffResponseSchema.parse({
      type: "subscribe_checkout_diff_response",
      payload: {
        subscriptionId: "diff-1",
        cwd: "/tmp/repo",
        files: [
          {
            path: "modules/service",
            isNew: false,
            isDeleted: false,
            additions: 1,
            deletions: 1,
            hunks: [],
          },
        ],
        error: null,
        requestId: "request-1",
      },
    });

    expect(parsed.payload.submodules).toBeUndefined();
    expect(parsed.payload.files[0]?.submodulePath).toBeUndefined();
  });

  test("legacy clients ignore additive submodule fields from new daemons", () => {
    const parsed = LegacySubscribeCheckoutDiffResponseSchema.parse({
      type: "subscribe_checkout_diff_response",
      payload: {
        subscriptionId: "diff-1",
        cwd: "/tmp/repo",
        files: [submoduleFile],
        submodules: [
          {
            path: "modules/service",
            branch: null,
            currentSha: "1111111111111111111111111111111111111111",
            checkoutState: "initialized",
            changeState: "dirty",
          },
        ],
        error: null,
        requestId: "request-1",
      },
    });

    expect(parsed).toEqual({
      type: "subscribe_checkout_diff_response",
      payload: {
        subscriptionId: "diff-1",
        cwd: "/tmp/repo",
        files: [
          {
            path: "modules/service/src/service.ts",
            isNew: false,
            isDeleted: false,
            additions: 4,
            deletions: 2,
            hunks: [],
          },
        ],
        error: null,
        requestId: "request-1",
      },
    });
  });

  test("accepts the diffSubmodules feature flag while keeping it optional", () => {
    const capable = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "server-1",
      features: { diffSubmodules: true },
    });
    const legacy = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "server-2",
      features: { providersSnapshot: true },
    });

    expect(capable.features?.diffSubmodules).toBe(true);
    expect(legacy.features?.diffSubmodules).toBeUndefined();
  });
});
