import YAML from "yaml";
import { describe, expect, it } from "vitest";
import {
  createHubInitScaffold,
  hubLoginResumeCommand,
  resolveHubInitConnection,
  type HubInitProvider,
} from "./init-plan.js";
import { githubRepositoryFromRemote } from "./init.js";

describe("Hub init planning", () => {
  it("prints direct resumable commands for declined login continuations", () => {
    expect(hubLoginResumeCommand("connect", "https://hub.test")).toBe(
      "paseo hub connect https://hub.test",
    );
    expect(hubLoginResumeCommand("init", "https://hub.test")).toBe("paseo hub init");
  });
  it("reuses a connected daemon, waits for reconnect, and rejects a different Hub", () => {
    const status = {
      state: "connected",
      daemonId: "daemon-1",
      hubOrigin: "https://hub.test",
      permissions: ["hub.execute"],
      connectedAt: null,
      lastError: null,
    };
    expect(resolveHubInitConnection(status, "https://hub.test")).toEqual({
      kind: "connected",
      daemonId: "daemon-1",
    });
    expect(resolveHubInitConnection(status, "https://other.test")).toEqual({
      kind: "conflict",
      origin: "https://hub.test",
    });
    expect(
      resolveHubInitConnection({ ...status, state: "reconnecting" }, "https://hub.test"),
    ).toEqual({ kind: "pending", state: "reconnecting" });
    expect(
      resolveHubInitConnection(
        { ...status, state: "not_connected", daemonId: null, hubOrigin: null },
        "https://hub.test",
      ),
    ).toEqual({ kind: "connect" });
  });
});

describe("Hub init scaffold", () => {
  it.each([
    ["github", { connection: "github-getpaseo", repo: "getpaseo/paseo", user: "boudra" }],
    ["slack", { connection: "slack-paseo", user: "U123456" }],
    ["discord", { connection: "discord-paseo", user: "987654321" }],
  ] satisfies readonly [HubInitProvider, Record<string, string>][])(
    "creates a self-contained %s organization trigger",
    (provider, providerFilters) => {
      const scaffold = createHubInitScaffold({
        cwd: "/workspace",
        daemonSlug: "build-studio",
        agent: {
          provider: "codex",
          model: "gpt-5",
          mode: "full-access",
        },
        provider,
        providerFilters,
      });
      expect(scaffold.triggerPath).toBe(`.paseo/triggers/${provider}-help.yml`);
      const parsed = YAML.parse(scaffold.trigger) as {
        name: string;
        enabled: boolean;
        max_runtime: string;
        on: Record<string, { connection?: string; filters: Record<string, unknown> }>;
        run: {
          target: { daemon: string; cwd: string };
          agent: { provider: string; model?: string; mode?: string };
          continuation: { mode: string };
          max_runtime: string;
          idle_timeout: string;
          prompt: string;
          outputs?: Record<string, { max: number; required: boolean }>;
        };
      };
      expect(parsed).toMatchObject({
        name: `${provider}-help`,
        enabled: true,
        max_runtime: "2h",
      });
      expect(Object.keys(parsed.on)).toEqual([
        provider === "github" ? "github.issue_comment" : `${provider}.mention`,
      ]);
      const event = Object.values(parsed.on)[0]!;
      expect(event.filters.from_users).toEqual([providerFilters.user]);
      if (provider === "github") expect(event.connection).toBe("github-getpaseo");
      if (provider === "slack") expect(event.connection).toBe("slack-paseo");
      if (provider === "discord") expect(event.connection).toBe("discord-paseo");
      expect(event.filters.channels).toBeUndefined();
      expect(parsed.run).toMatchObject({
        target: { daemon: "build-studio", cwd: "/workspace" },
        agent: { provider: "codex", model: "gpt-5", mode: "full-access" },
        continuation: { mode: "conversation" },
        max_runtime: "90m",
        idle_timeout: "10m",
      });
      expect(parsed.run.prompt).toContain("hub.finish_execution");
      expect(parsed.run.prompt).toContain("${{ paseo.prompt }}");
      expect(parsed.run.outputs).toEqual(
        provider === "github" ? undefined : { [`${provider}.reply`]: { max: 1, required: true } },
      );
    },
  );
});

describe("GitHub origin detection", () => {
  it.each([
    ["git@github.com:getpaseo/paseo.git", "getpaseo/paseo"],
    ["ssh://git@github.com/getpaseo/paseo.git", "getpaseo/paseo"],
    ["https://github.com/getpaseo/paseo.git", "getpaseo/paseo"],
    ["https://gitlab.com/getpaseo/paseo.git", undefined],
  ])("resolves %s", (remote, expected) => {
    expect(githubRepositoryFromRemote(remote)).toBe(expected);
  });
});
