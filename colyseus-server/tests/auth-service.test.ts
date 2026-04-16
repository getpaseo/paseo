import { describe, it, expect, vi, beforeEach } from "vitest";
import { AuthService } from "../src/services/auth-service.js";

describe("AuthService", () => {
  let authService: AuthService;

  beforeEach(() => {
    authService = new AuthService("http://localhost:9999");
  });

  describe("validateShareToken", () => {
    it("returns allowed=true when auth-server responds 200", async () => {
      const mockResponse = {
        shareId: "share-1",
        daemonSessionId: "session-1",
        serverId: "server-1",
        accessLevel: "full_access",
        owner: { userId: "owner-1", username: "Owner", avatarUrl: "" },
        currentUser: {
          userId: "user-1",
          username: "User",
          avatarUrl: "",
          isOwner: false,
        },
      };

      vi.spyOn(global, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), { status: 200 }),
      );

      const result = await authService.validateShareToken("valid-token", "session-token");
      expect(result.allowed).toBe(true);
      expect(result.user?.userId).toBe("user-1");
      expect(result.user?.isOwner).toBe(false);
      expect(result.accessLevel).toBe("full_access");
    });

    it("returns allowed=false when token is invalid (404)", async () => {
      vi.spyOn(global, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Invalid or expired share link" }), { status: 404 }),
      );

      const result = await authService.validateShareToken("bad-token", "session-token");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Invalid or expired");
    });

    it("returns allowed=false when user is not invited (403)", async () => {
      vi.spyOn(global, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "You are not invited" }), { status: 403 }),
      );

      const result = await authService.validateShareToken("token", "session-token");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("not invited");
    });

    it("handles network errors gracefully", async () => {
      vi.spyOn(global, "fetch").mockRejectedValueOnce(new Error("ECONNREFUSED"));

      const result = await authService.validateShareToken("token", "session-token");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("ECONNREFUSED");
    });

    it("sends correct Authorization header", async () => {
      const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
      );

      await authService.validateShareToken("tok", "my-session-token");

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining("/api/sessions/share/tok"),
        expect.objectContaining({
          headers: { Authorization: "Bearer my-session-token" },
        }),
      );
    });
  });

  describe("recordJoin", () => {
    it("calls participants endpoint with join action", async () => {
      const fetchSpy = vi
        .spyOn(global, "fetch")
        .mockResolvedValueOnce(new Response(JSON.stringify({ success: true })));

      await authService.recordJoin("share-1", "user-1");

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining("/api/sessions/share/share-1/participants"),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ userId: "user-1", action: "join" }),
        }),
      );
    });

    it("does not throw on network error", async () => {
      vi.spyOn(global, "fetch").mockRejectedValueOnce(new Error("fail"));
      await expect(authService.recordJoin("share-1", "user-1")).resolves.toBeUndefined();
    });
  });

  describe("recordLeave", () => {
    it("calls participants endpoint with leave action", async () => {
      const fetchSpy = vi
        .spyOn(global, "fetch")
        .mockResolvedValueOnce(new Response(JSON.stringify({ success: true })));

      await authService.recordLeave("share-1", "user-1");

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining("/api/sessions/share/share-1/participants"),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ userId: "user-1", action: "leave" }),
        }),
      );
    });

    it("does not throw on network error", async () => {
      vi.spyOn(global, "fetch").mockRejectedValueOnce(new Error("fail"));
      await expect(authService.recordLeave("share-1", "user-1")).resolves.toBeUndefined();
    });
  });
});
