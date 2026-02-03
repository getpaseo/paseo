import { describe, expect, it } from "vitest";
import { checkoutStatusRevalidationKey, nextCheckoutStatusRefetchDecision } from "./checkout-status-revalidation";

describe("useCheckoutStatusQuery", () => {
  describe("checkoutStatusRevalidationKey", () => {
    it("returns null when sidebar is closed", () => {
      expect(
        checkoutStatusRevalidationKey({
          serverId: "daemon-1",
          cwd: "/path/to/project",
          isOpen: false,
          explorerTab: "changes",
        })
      ).toBeNull();
    });

    it("returns null when tab is not changes", () => {
      expect(
        checkoutStatusRevalidationKey({
          serverId: "daemon-1",
          cwd: "/path/to/project",
          isOpen: true,
          explorerTab: "files",
        })
      ).toBeNull();
    });

    it("returns a stable key when open and on changes tab", () => {
      expect(
        checkoutStatusRevalidationKey({
          serverId: "daemon-1",
          cwd: "/path/to/project",
          isOpen: true,
          explorerTab: "changes",
        })
      ).toBe("daemon-1:/path/to/project");
    });
  });

  describe("nextCheckoutStatusRefetchDecision", () => {
    it("refetches only once per key until reset", () => {
      const key = "daemon-1:/path/to/project";

      expect(nextCheckoutStatusRefetchDecision(null, key)).toEqual({
        nextSeenKey: key,
        shouldRefetch: true,
      });

      expect(nextCheckoutStatusRefetchDecision(key, key)).toEqual({
        nextSeenKey: key,
        shouldRefetch: false,
      });

      expect(nextCheckoutStatusRefetchDecision(key, null)).toEqual({
        nextSeenKey: null,
        shouldRefetch: false,
      });

      expect(nextCheckoutStatusRefetchDecision(null, key)).toEqual({
        nextSeenKey: key,
        shouldRefetch: true,
      });
    });

    it("refetches again when cwd changes while active", () => {
      expect(
        nextCheckoutStatusRefetchDecision("daemon-1:/path/a", "daemon-1:/path/b")
      ).toEqual({
        nextSeenKey: "daemon-1:/path/b",
        shouldRefetch: true,
      });
    });
  });
});
