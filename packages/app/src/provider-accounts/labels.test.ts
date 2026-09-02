import { describe, expect, it } from "vitest";
import { resolveProviderAccountLabel } from "./labels";

const accounts = [
  {
    id: "pac_0123456789abcdef",
    provider: "codex" as const,
    name: "Work",
    identity: null,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
    lastAuthenticatedAt: null,
  },
];

describe("resolveProviderAccountLabel", () => {
  it("distinguishes inherited, system, managed, and missing accounts", () => {
    expect(resolveProviderAccountLabel(undefined, accounts)).toBeNull();
    expect(resolveProviderAccountLabel(null, accounts)).toBe("System account");
    expect(resolveProviderAccountLabel("pac_0123456789abcdef", accounts)).toBe("Work");
    expect(resolveProviderAccountLabel("pac_fedcba9876543210", accounts)).toBe(
      "Unavailable account",
    );
  });
});
