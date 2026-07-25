import { FORGE_IDS } from "@getpaseo/protocol/forge-manifest";
import { describe, expect, it, vi } from "vitest";

import { createForgeService, defaultForgeRegistry, ForgeRegistry } from "./forge-registry.js";
import { createGitHubService } from "./github-service.js";

describe("forge registry", () => {
  it("builds the registered adapters", () => {
    const github = createForgeService("github");
    const gitlab = createForgeService("gitlab");
    const gitea = createForgeService("gitea");
    const forgejo = createForgeService("forgejo");
    const codeberg = createForgeService("codeberg");
    expect(github?.getCurrentPullRequestStatus).toBeTypeOf("function");
    expect(gitlab?.getCurrentPullRequestStatus).toBeTypeOf("function");
    expect(gitea?.getCurrentPullRequestStatus).toBeTypeOf("function");
    expect(forgejo?.getCurrentPullRequestStatus).toBeTypeOf("function");
    expect(codeberg?.getCurrentPullRequestStatus).toBeTypeOf("function");
  });

  it("returns null for an unregistered forge", () => {
    expect(createForgeService("bitbucket")).toBeNull();
  });

  it("keeps the built-in registry in sync with the forge manifest", () => {
    expect([...defaultForgeRegistry.ids()].sort()).toEqual([...FORGE_IDS].sort());
  });

  it("knows which forges are registered", () => {
    expect(defaultForgeRegistry.has("github")).toBe(true);
    expect(defaultForgeRegistry.has("gitlab")).toBe(true);
    expect(defaultForgeRegistry.has("gitea")).toBe(true);
    expect(defaultForgeRegistry.has("forgejo")).toBe(true);
    expect(defaultForgeRegistry.has("codeberg")).toBe(true);
    expect(defaultForgeRegistry.has("bitbucket")).toBe(false);
    expect(defaultForgeRegistry.ids()).toEqual(
      expect.arrayContaining(["github", "gitlab", "gitea", "forgejo", "codeberg"]),
    );
  });

  it("registers a third-party adapter without changing the registry implementation", () => {
    const unregister = defaultForgeRegistry.register("bitbucket", {
      createService: createGitHubService,
      matchesHost: (host) => host === "bitbucket.org",
    });
    try {
      expect(defaultForgeRegistry.has("bitbucket")).toBe(true);
      expect(createForgeService("bitbucket")?.getCurrentPullRequestStatus).toBeTypeOf("function");
    } finally {
      unregister();
    }
    expect(defaultForgeRegistry.has("bitbucket")).toBe(false);
  });

  it("lets adapters own heuristic and asynchronous host detection", async () => {
    const registry = new ForgeRegistry([
      [
        "bitbucket",
        {
          createService: createGitHubService,
          matchesHost: (host) => host === "bitbucket.org",
          probeHost: async (host) => host === "git.acme.internal",
        },
      ],
    ]);

    expect(registry.matchHost("bitbucket.org")).toBe("bitbucket");
    await expect(registry.probeHost("git.acme.internal")).resolves.toBe("bitbucket");
  });

  it("does not infer self-managed forges from host substrings", () => {
    expect(defaultForgeRegistry.matchHost("gitea-forgejo.example.org")).toBeNull();
    expect(defaultForgeRegistry.matchHost("gitlab.example.org")).toBeNull();
    expect(defaultForgeRegistry.matchHost("notgitlab.example.org")).toBeNull();
  });

  it("treats a probe that throws as 'not this forge' rather than crashing detection", async () => {
    const registry = new ForgeRegistry([
      [
        "flaky",
        {
          createService: createGitHubService,
          probeHost: async () => {
            throw new Error("CLI not installed");
          },
        },
      ],
      [
        "reachable",
        {
          createService: createGitHubService,
          probeHost: async (host) => host === "git.acme.internal",
        },
      ],
    ]);

    await expect(registry.probeHost("git.acme.internal")).resolves.toBe("reachable");
    await expect(registry.probeHost("git.unknown.internal")).resolves.toBeNull();
  });

  it("degrades ambiguous host detection to no forge instead of depending on registration order", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const registry = new ForgeRegistry([
        [
          "first",
          {
            createService: createGitHubService,
            matchesHost: () => true,
            probeHost: async () => true,
          },
        ],
        [
          "second",
          {
            createService: createGitHubService,
            matchesHost: () => true,
            probeHost: async () => true,
          },
        ],
      ]);

      expect(registry.matchHost("git.acme.internal")).toBeNull();
      await expect(registry.probeHost("git.acme.internal")).resolves.toBeNull();
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/Multiple forge adapters matched host/),
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/Multiple forge adapters recognized host/),
      );
    } finally {
      warn.mockRestore();
    }
  });
});
