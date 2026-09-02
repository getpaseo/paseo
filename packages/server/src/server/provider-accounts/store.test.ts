import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ProviderAccountNameConflictError,
  ProviderAccountNotFoundError,
  ProviderAccountStore,
} from "./store.js";
import { PRIVATE_DIRECTORY_MODE } from "../private-files.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createStore() {
  const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-provider-accounts-"));
  roots.push(paseoHome);
  const root = path.join(paseoHome, "provider-accounts");
  let nextId = 0;
  let now = Date.parse("2026-08-23T00:00:00.000Z");
  const store = new ProviderAccountStore(root, {
    createId: () => `pac_${String(++nextId).padStart(16, "0")}`,
    now: () => new Date(now++),
  });
  return { root, store };
}

describe("ProviderAccountStore", () => {
  it("persists metadata privately while deriving runtime homes outside the payload", async () => {
    const { root, store } = createStore();

    const created = await store.create({ provider: "codex", name: "  Client   Work " });
    if (process.platform !== "win32") {
      expect(statSync(created.runtimeHome).mode & 0o777).toBe(PRIVATE_DIRECTORY_MODE);
    }

    expect(created).toEqual({
      id: "pac_0000000000000001",
      provider: "codex",
      name: "Client Work",
      identity: null,
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:00.000Z",
      lastAuthenticatedAt: null,
      runtimeHome: path.join(root, "codex", "pac_0000000000000001"),
    });

    const persisted = JSON.parse(readFileSync(path.join(root, "accounts.json"), "utf8"));
    expect(persisted.accounts[0]).not.toHaveProperty("runtimeHome");
    expect(JSON.stringify(persisted)).not.toContain(created.runtimeHome);

    const reloaded = new ProviderAccountStore(root);
    expect(reloaded.get(created.id)).toEqual(created);
  });

  it("serializes concurrent creates and rejects a duplicate provider-scoped name", async () => {
    const { store } = createStore();

    const results = await Promise.allSettled([
      store.create({ provider: "codex", name: "Work" }),
      store.create({ provider: "codex", name: " work " }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(ProviderAccountNameConflictError);
    expect(store.list().accounts).toHaveLength(1);

    await expect(store.create({ provider: "claude", name: "Work" })).resolves.toMatchObject({
      provider: "claude",
      name: "Work",
    });
  });

  it("pins defaults by provider and returns to the system account after removal", async () => {
    const { root, store } = createStore();
    const codex = await store.create({ provider: "codex", name: "Personal" });
    const claude = await store.create({ provider: "claude", name: "Work" });

    await store.selectDefault("codex", codex.id);
    await store.selectDefault("claude", claude.id);
    expect(store.list().defaults).toEqual({ codex: codex.id, claude: claude.id });

    await store.remove(codex.id);
    expect(store.list().defaults).toEqual({ codex: null, claude: claude.id });
    expect(() => store.get(codex.id)).not.toThrow();
    expect(store.get(codex.id)).toBeNull();
    expect(() => readFileSync(path.join(root, "codex", codex.id, "auth.json"))).toThrow();
  });

  it("updates identity and rejects cross-provider defaults or missing accounts", async () => {
    const { store } = createStore();
    const account = await store.create({ provider: "codex", name: "Work" });

    await expect(
      store.updateIdentity(account.id, {
        email: "edi@example.com",
        organization: "Reachout",
        plan: "pro",
      }),
    ).resolves.toMatchObject({
      identity: { email: "edi@example.com", organization: "Reachout", plan: "pro" },
      lastAuthenticatedAt: "2026-08-23T00:00:00.001Z",
    });
    await expect(store.selectDefault("claude", account.id)).rejects.toThrow(
      `${account.id} belongs to codex, not claude`,
    );
    await expect(store.rename("pac_ffffffffffffffff", "Missing")).rejects.toBeInstanceOf(
      ProviderAccountNotFoundError,
    );
  });
});
