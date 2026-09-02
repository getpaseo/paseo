import { describe, expect, it } from "vitest";
import { toProviderAccountRows } from "./accounts";

describe("provider accounts rows", () => {
  it("shows stable IDs, authentication, and provider-scoped defaults", () => {
    expect(
      toProviderAccountRows({
        accounts: [
          {
            id: "pac_0123456789abcdef",
            provider: "codex",
            name: "Work",
            identity: { email: "edi@example.com", plan: "pro" },
            createdAt: "2026-08-24T00:00:00.000Z",
            updatedAt: "2026-08-24T00:00:00.000Z",
            lastAuthenticatedAt: "2026-08-24T00:00:00.000Z",
          },
        ],
        defaults: { codex: "pac_0123456789abcdef" },
      }),
    ).toEqual([
      {
        id: "pac_0123456789abcdef",
        provider: "codex",
        name: "Work",
        default: "Yes",
        status: "Signed in",
        email: "edi@example.com",
        plan: "pro",
      },
    ]);
  });
});
