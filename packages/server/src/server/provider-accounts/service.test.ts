import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createExternalProcessEnv } from "../paseo-env.js";
import {
  ProviderAccountInUseError,
  ProviderAccountService,
  ProviderAccountProviderMismatchError,
} from "./service.js";
import { ProviderAccountStore } from "./store.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createService(options?: ConstructorParameters<typeof ProviderAccountService>[1]) {
  const root = mkdtempSync(path.join(tmpdir(), "paseo-provider-account-service-"));
  roots.push(root);
  let nextId = 0;
  const store = new ProviderAccountStore(path.join(root, "provider-accounts"), {
    createId: () => `pac_${String(++nextId).padStart(16, "0")}`,
    now: () => new Date("2026-08-23T00:00:00.000Z"),
  });
  return new ProviderAccountService(store, options);
}

describe("ProviderAccountService", () => {
  it("returns public profiles without exposing runtime homes", async () => {
    const service = createService();
    const account = await service.create({ provider: "codex", name: "Work" });

    expect(account).toEqual({
      id: "pac_0000000000000001",
      provider: "codex",
      name: "Work",
      identity: null,
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:00.000Z",
      lastAuthenticatedAt: null,
    });
    expect(service.list().accounts[0]).not.toHaveProperty("runtimeHome");
  });

  it("isolates Codex and Claude homes while removing inherited auth overrides", async () => {
    const service = createService();
    const codex = await service.create({ provider: "codex", name: "Personal" });
    const claude = await service.create({ provider: "claude", name: "Work" });

    const codexLaunch = service.resolveLaunch({
      provider: "codex",
      accountProfileId: codex.id,
    });
    const codexEnv = createExternalProcessEnv(
      { OPENAI_API_KEY: "should-not-leak", OPENAI_BASE_URL: "https://proxy.test" },
      codexLaunch.envOverlay,
    );
    expect(codexEnv.CODEX_HOME).toContain(codex.id);
    expect(codexEnv.OPENAI_API_KEY).toBeUndefined();
    expect(codexEnv.OPENAI_BASE_URL).toBeUndefined();

    const claudeLaunch = service.resolveLaunch({
      provider: "claude",
      accountProfileId: claude.id,
    });
    const claudeEnv = createExternalProcessEnv(
      { ANTHROPIC_API_KEY: "should-not-leak", CLAUDE_CODE_OAUTH_TOKEN: "old-token" },
      claudeLaunch.envOverlay,
    );
    expect(claudeEnv.CLAUDE_CONFIG_DIR).toContain(claude.id);
    expect(claudeEnv.ANTHROPIC_API_KEY).toBeUndefined();
    expect(claudeEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it("rejects an account selected for a different provider", async () => {
    const service = createService();
    const account = await service.create({ provider: "codex", name: "Work" });

    expect(() =>
      service.resolveLaunch({ provider: "claude", accountProfileId: account.id }),
    ).toThrow(ProviderAccountProviderMismatchError);
  });

  it("keeps the system account as the empty launch overlay", () => {
    const service = createService();

    expect(service.resolveLaunch({ provider: "codex", accountProfileId: null })).toEqual({
      account: null,
      envOverlay: {},
    });
    expect(service.resolveDefaultAccountId("opencode")).toBeNull();
  });

  it("rejects an empty managed account id instead of treating it as System", () => {
    const service = createService();
    expect(() => service.resolveLaunch({ provider: "codex", accountProfileId: "" })).toThrow(
      "Provider account not found",
    );
  });

  it("refuses to remove an account pinned to an active agent", async () => {
    const service = createService({
      listActiveAgentIds: async () => ["agent-a", "agent-b"],
    });
    const account = await service.create({ provider: "codex", name: "Work" });

    await expect(service.remove(account.id)).rejects.toMatchObject({
      code: "provider_account_in_use",
      agentIds: ["agent-a", "agent-b"],
    } satisfies Partial<ProviderAccountInUseError>);
    expect(service.list().accounts).toHaveLength(1);
  });
});
