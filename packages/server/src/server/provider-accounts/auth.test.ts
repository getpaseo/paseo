import { describe, expect, it, vi } from "vitest";
import type { ProviderAccountIdentity } from "@getpaseo/protocol/provider-accounts";
import { ProviderAccountAuthManager, type ProviderLoginHandle } from "./auth.js";
import type { ProviderAccountRecord } from "./store.js";

function logger() {
  const value = {
    child: () => value,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return value as never;
}

function account(provider: "codex" | "claude" = "codex"): ProviderAccountRecord {
  return {
    id: "pac_0123456789abcdef",
    provider,
    name: "Work",
    identity: null,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
    lastAuthenticatedAt: null,
    runtimeHome: "/private/provider-account",
  };
}

function deferredHandle(): {
  handle: ProviderLoginHandle;
  resolve: (identity: ProviderAccountIdentity) => void;
  reject: (error: Error) => void;
  cancel: ReturnType<typeof vi.fn>;
} {
  let resolve!: (identity: ProviderAccountIdentity) => void;
  let reject!: (error: Error) => void;
  const completion = new Promise<ProviderAccountIdentity>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  const cancel = vi.fn(async () => undefined);
  return {
    handle: {
      loginId: "login-1",
      verificationUrl: "https://example.com/device",
      userCode: "ABCD-EFGH",
      completion,
      cancel,
    },
    resolve,
    reject,
    cancel,
  };
}

describe("ProviderAccountAuthManager", () => {
  it("publishes a device challenge then records authenticated identity", async () => {
    const deferred = deferredHandle();
    const onAuthenticated = vi.fn(async () => undefined);
    const manager = new ProviderAccountAuthManager({
      logger: logger(),
      onAuthenticated,
      starters: {
        codex: async () => deferred.handle,
        claude: async () => deferred.handle,
      },
    });

    await expect(manager.start(account())).resolves.toMatchObject({
      status: "waiting",
      loginId: "login-1",
      verificationUrl: "https://example.com/device",
      userCode: "ABCD-EFGH",
    });

    deferred.resolve({ email: "edi@example.com", plan: "pro" });
    await vi.waitFor(() => expect(manager.status(account().id).status).toBe("succeeded"));
    expect(onAuthenticated).toHaveBeenCalledWith(account().id, {
      email: "edi@example.com",
      plan: "pro",
    });
  });

  it("cancels an active login without letting its completion overwrite the state", async () => {
    const deferred = deferredHandle();
    const manager = new ProviderAccountAuthManager({
      logger: logger(),
      onAuthenticated: vi.fn(async () => undefined),
      starters: {
        codex: async () => deferred.handle,
        claude: async () => deferred.handle,
      },
    });
    await manager.start(account());

    await expect(manager.cancel(account().id)).resolves.toMatchObject({ status: "canceled" });
    expect(deferred.cancel).toHaveBeenCalledOnce();
    deferred.resolve({ email: "too-late@example.com" });
    await Promise.resolve();
    expect(manager.status(account().id).status).toBe("canceled");
  });

  it("surfaces provider login failures as state instead of throwing from status polling", async () => {
    const deferred = deferredHandle();
    const manager = new ProviderAccountAuthManager({
      logger: logger(),
      onAuthenticated: vi.fn(async () => undefined),
      starters: {
        codex: async () => deferred.handle,
        claude: async () => deferred.handle,
      },
    });
    await manager.start(account());

    deferred.reject(new Error("authorization expired"));
    await vi.waitFor(() => expect(manager.status(account().id).status).toBe("failed"));
    expect(manager.status(account().id).error).toBe("authorization expired");
  });
});
