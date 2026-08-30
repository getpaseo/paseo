import pino from "pino";
import { describe, expect, it } from "vitest";
import { buildProfileUsageFetchers, createProfileUsageFetcherSource } from "./profile-fetchers.js";

const logger = pino({ level: "silent" });

describe("buildProfileUsageFetchers", () => {
  it("creates one fetcher per Claude profile with a pinned token, keyed by profile id", () => {
    const fetchers = buildProfileUsageFetchers({
      logger,
      providers: {
        "claude-work": {
          extends: "claude",
          label: "Claude (Work)",
          env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-work" },
        },
        "claude-personal": {
          extends: "claude",
          env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-personal" },
        },
      },
    });

    expect(fetchers.map((f) => [f.providerId, f.displayName])).toEqual([
      ["claude-work", "Claude (Work)"],
      ["claude-personal", "claude-personal"],
    ]);
  });

  it("skips disabled profiles, non-claude bases, and profiles without a token", () => {
    const fetchers = buildProfileUsageFetchers({
      logger,
      providers: {
        "claude-disabled": {
          extends: "claude",
          enabled: false,
          env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-disabled" },
        },
        "codex-work": {
          extends: "codex",
          env: { OPENAI_API_KEY: "sk-openai" },
        },
        // Shared-login profile: the base "claude" entry already describes it.
        "claude-shared": { extends: "claude", env: { CLAUDE_CONFIG_DIR: "/tmp/other" } },
        "claude-blank-token": { extends: "claude", env: { CLAUDE_CODE_OAUTH_TOKEN: "   " } },
      },
    });

    expect(fetchers).toEqual([]);
  });

  it("returns nothing when no providers are configured", () => {
    expect(buildProfileUsageFetchers({ logger, providers: undefined })).toEqual([]);
  });
});

describe("createProfileUsageFetcherSource", () => {
  it("keeps a profile's fetcher instance across refreshes while its identity is unchanged", () => {
    let providers: Record<string, unknown> = {
      "claude-work": {
        extends: "claude",
        env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-work" },
      },
    };
    const source = createProfileUsageFetcherSource({ logger, getProviders: () => providers });

    const first = source()[0];
    const second = source()[0];
    expect(second).toBe(first);

    // A new token is a new account: the cached instance (and any state it
    // accumulated for the old token) must not carry over.
    providers = {
      "claude-work": {
        extends: "claude",
        env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-rotated" },
      },
    };
    const third = source()[0];
    expect(third).not.toBe(first);
  });

  it("drops the cached instance when the profile leaves the config", () => {
    let providers: Record<string, unknown> = {
      "claude-work": {
        extends: "claude",
        env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-work" },
      },
    };
    const source = createProfileUsageFetcherSource({ logger, getProviders: () => providers });
    const original = source()[0];

    providers = {};
    expect(source()).toEqual([]);

    providers = {
      "claude-work": {
        extends: "claude",
        env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-work" },
      },
    };
    expect(source()[0]).not.toBe(original);
  });
});
