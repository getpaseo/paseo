import { describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

vi.mock("expo-notifications", async () => await import("../../fdroid/expo-notifications"));
vi.mock("expo-constants", () => ({ default: {} }));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async () => null,
    removeItem: vi.fn(async () => {}),
    setItem: async () => {},
  },
}));
import { registerRotatedPushToken } from "./token-registration";

describe("push token rotation", () => {
  it("registers the replacement before revoking the cached token", async () => {
    const operations: string[] = [];
    const client = {
      isConnected: true,
      registerPushToken: (token: string) => {
        operations.push(`register:${token}`);
      },
      unregisterPushToken: async (token: string) => {
        operations.push(`revoke:${token}`);
      },
    };
    await registerRotatedPushToken({
      client,
      token: "new",
      previousToken: "old",
      supportsRevocation: true,
    });
    expect(operations).toEqual(["register:new", "revoke:old"]);
  });
  it("retains the subscription across reconnects and supports older daemons", async () => {
    const operations: string[] = [];
    const client = {
      isConnected: true,
      registerPushToken: (token: string) => {
        operations.push(token);
      },
      unregisterPushToken: async () => {
        throw new Error("Unexpected revocation");
      },
    };
    await registerRotatedPushToken({
      client,
      token: "same",
      previousToken: "same",
      supportsRevocation: true,
    });
    await registerRotatedPushToken({
      client,
      token: "new",
      previousToken: "same",
      supportsRevocation: false,
    });
    expect(operations).toEqual(["same", "new"]);
  });
  it("does not register disconnected clients and revokes denied permissions", async () => {
    const revoked: string[] = [];
    const client = {
      isConnected: false,
      registerPushToken: () => {
        throw new Error("Unexpected registration");
      },
      unregisterPushToken: async (token: string) => {
        revoked.push(token);
      },
    };
    await registerRotatedPushToken({
      client,
      token: "token",
      previousToken: "old",
      supportsRevocation: true,
    });
    expect(revoked).toEqual([]);
    client.isConnected = true;
    await registerRotatedPushToken({
      client,
      token: null,
      previousToken: "old",
      supportsRevocation: true,
    });
    expect(revoked).toEqual(["old"]);
  });

  it("starts and closes a source-only subscription without native notification APIs or Expo registration", async () => {
    const { startSubscription } = await import("./subscriptions");
    const storage = (await import("@react-native-async-storage/async-storage")).default;
    const unsubscribe = vi.fn();
    const client = {
      isConnected: true,
      registerPushToken: vi.fn(),
      unregisterPushToken: vi.fn(),
      getLastServerInfoMessage: () => null,
      subscribeConnectionStatus: () => unsubscribe,
    };
    const stop = startSubscription({
      client: client as unknown as DaemonClient,
      serverId: "source-only",
    });
    await vi.waitFor(() =>
      expect(storage.removeItem).toHaveBeenCalledWith("@paseo:expo-push-token:source-only"),
    );
    expect(client.registerPushToken).not.toHaveBeenCalled();
    stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
