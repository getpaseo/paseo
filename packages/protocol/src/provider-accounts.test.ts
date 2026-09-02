import { describe, expect, it } from "vitest";
import {
  normalizeProviderAccountName,
  providerAccountNameKey,
  ProviderAccountProfileSchema,
} from "./provider-accounts.js";

describe("provider accounts", () => {
  it("normalizes account names for display and provider-scoped uniqueness", () => {
    expect(normalizeProviderAccountName("  Client   Work  ")).toBe("Client Work");
    expect(providerAccountNameKey("  CLIENT work ")).toBe("client work");
  });

  it("keeps provider account payloads free of runtime paths and credentials", () => {
    const parsed = ProviderAccountProfileSchema.parse({
      id: "pac_0123456789abcdef",
      provider: "codex",
      name: "Work",
      identity: { email: "edi@example.com", plan: "pro" },
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:00.000Z",
      lastAuthenticatedAt: null,
    });

    expect(parsed).toEqual({
      id: "pac_0123456789abcdef",
      provider: "codex",
      name: "Work",
      identity: { email: "edi@example.com", plan: "pro" },
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:00.000Z",
      lastAuthenticatedAt: null,
    });
    expect(() =>
      ProviderAccountProfileSchema.parse({
        ...parsed,
        runtimeHome: "/tmp/secret-home",
      }),
    ).toThrow();
  });
});
