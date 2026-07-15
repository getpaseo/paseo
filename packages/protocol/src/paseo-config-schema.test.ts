import { describe, expect, it } from "vitest";
import {
  AgentEnvRawSchema,
  PaseoConfigRawSchema,
  PaseoConfigSchema,
} from "@getpaseo/protocol/paseo-config-schema";

describe("paseo config schema", () => {
  it("parses an empty config without metadata generation", () => {
    const parsed = PaseoConfigSchema.parse({});

    expect(parsed).toEqual({});
    expect(parsed.metadataGeneration).toBeUndefined();
  });

  it("parses old-style worktree and scripts config unchanged", () => {
    const config = {
      worktree: {
        setup: "npm install",
        teardown: ["npm run clean"],
      },
      scripts: {
        dev: {
          type: "service",
          command: "npm run dev",
          port: 5173,
        },
      },
    };

    expect(PaseoConfigSchema.parse(config)).toEqual({
      worktree: {
        setup: ["npm install"],
        teardown: ["npm run clean"],
      },
      scripts: config.scripts,
    });
  });

  it("normalizes a single agentEnv command into one layer", () => {
    expect(PaseoConfigSchema.parse({ agentEnv: "  direnv exec . env -0  " }).agentEnv).toEqual([
      { kind: "command", command: "direnv exec . env -0" },
    ]);
    // Round-trips unchanged through the raw schema (UI read/write path).
    expect(PaseoConfigRawSchema.parse({ agentEnv: "mise env --json" }).agentEnv).toBe(
      "mise env --json",
    );
  });

  it("normalizes a static agentEnv map into one layer", () => {
    expect(PaseoConfigSchema.parse({ agentEnv: { FOO: "bar" } }).agentEnv).toEqual([
      { kind: "static", vars: { FOO: "bar" } },
    ]);
    expect(PaseoConfigRawSchema.parse({ agentEnv: { FOO: "bar" } }).agentEnv).toEqual({
      FOO: "bar",
    });
  });

  it("normalizes a mixed agentEnv list into layers, preserving order", () => {
    expect(
      PaseoConfigSchema.parse({
        agentEnv: [{ STATIC: "1" }, "direnv exec . env -0"],
      }).agentEnv,
    ).toEqual([
      { kind: "static", vars: { STATIC: "1" } },
      { kind: "command", command: "direnv exec . env -0" },
    ]);
  });

  it("drops blank and empty agentEnv entries", () => {
    expect(PaseoConfigSchema.parse({ agentEnv: "   " }).agentEnv).toBeUndefined();
    expect(PaseoConfigSchema.parse({ agentEnv: {} }).agentEnv).toBeUndefined();
    expect(PaseoConfigSchema.parse({ worktree: { setup: "npm i" } }).agentEnv).toBeUndefined();
  });

  it("rejects malformed agentEnv at the raw schema, so the server can fail the launch", () => {
    // The normalizer is deliberately defensive (a bad config must not brick config reads), but
    // silently dropping a layer would launch an agent with a PARTIAL environment. The raw schema
    // is the strict gate; `getAgentEnvLayers` validates against it and throws. See worktree.ts.
    expect(AgentEnvRawSchema.safeParse([{ TOKEN: "ok" }, { API_KEY: 123 }]).success).toBe(false);
    expect(AgentEnvRawSchema.safeParse([42, "direnv exec . env -0"]).success).toBe(false);
    expect(AgentEnvRawSchema.safeParse({ TOKEN: "ok" }).success).toBe(true);
    expect(AgentEnvRawSchema.safeParse("direnv exec . env -0").success).toBe(true);
    expect(AgentEnvRawSchema.safeParse([{ A: "1" }, "cmd"]).success).toBe(true);
  });

  it("normalizes partial worktree lifecycle config without dropping present commands", () => {
    expect(
      PaseoConfigSchema.parse({
        worktree: {
          setup: 'echo "setup ran" > setup.log',
        },
      }),
    ).toEqual({
      worktree: {
        setup: ['echo "setup ran" > setup.log'],
        teardown: [],
      },
    });

    expect(
      PaseoConfigSchema.parse({
        worktree: {
          teardown: ["npm run clean"],
        },
      }),
    ).toEqual({
      worktree: {
        setup: [],
        teardown: ["npm run clean"],
      },
    });
  });

  it("parses all metadata generation instruction entries", () => {
    expect(
      PaseoConfigSchema.parse({
        metadataGeneration: {
          title: { instructions: "Keep titles to a few words." },
          branchName: { instructions: "Prefix branches with feat/." },
          commitMessage: { instructions: "Use imperative mood." },
          pullRequest: { instructions: "Include risk notes." },
        },
      }),
    ).toEqual({
      metadataGeneration: {
        title: { instructions: "Keep titles to a few words." },
        branchName: { instructions: "Prefix branches with feat/." },
        commitMessage: { instructions: "Use imperative mood." },
        pullRequest: { instructions: "Include risk notes." },
      },
    });
  });

  it("parses partial metadata generation instructions with missing entries undefined", () => {
    const parsed = PaseoConfigSchema.parse({
      metadataGeneration: {
        branchName: { instructions: "Keep it short." },
      },
    });

    expect(parsed.metadataGeneration).toEqual({
      branchName: { instructions: "Keep it short." },
    });
    expect(parsed.metadataGeneration?.commitMessage).toBeUndefined();
    expect(parsed.metadataGeneration?.pullRequest).toBeUndefined();
  });

  it("preserves legacy agentTitle metadata instructions as passthrough", () => {
    expect(
      PaseoConfigSchema.parse({
        metadataGeneration: {
          agentTitle: { instructions: "Use concise titles." },
        },
      }),
    ).toEqual({
      metadataGeneration: {
        agentTitle: { instructions: "Use concise titles." },
      },
    });
  });

  it("passes through unknown metadata generation fields", () => {
    expect(
      PaseoConfigSchema.parse({
        metadataGeneration: {
          futureField: 42,
        },
      }),
    ).toEqual({
      metadataGeneration: {
        futureField: 42,
      },
    });
  });

  it("passes through unknown metadata generator entry fields", () => {
    expect(
      PaseoConfigSchema.parse({
        metadataGeneration: {
          branchName: {
            instructions: "Use concise titles.",
            model: "haiku",
          },
        },
      }),
    ).toEqual({
      metadataGeneration: {
        branchName: {
          instructions: "Use concise titles.",
          model: "haiku",
        },
      },
    });
  });

  it("falls back to an empty metadata generator entry when instructions has an invalid type", () => {
    expect(
      PaseoConfigSchema.parse({
        metadataGeneration: {
          branchName: { instructions: 42 },
        },
      }),
    ).toEqual({
      metadataGeneration: {
        branchName: {},
      },
    });
  });

  it("raw schema preserves old-style config while accepting legacy agentTitle", () => {
    const config = {
      worktree: {
        setup: "npm install",
        teardown: ["npm run clean"],
      },
      scripts: {
        dev: {
          type: "service",
          command: "npm run dev",
        },
      },
      metadataGeneration: {
        agentTitle: { instructions: "Use concise titles." },
        branchName: { instructions: "Use concise branches." },
      },
    };

    expect(PaseoConfigRawSchema.parse(config)).toEqual(config);
  });

  it("raw schema falls back to an empty metadata generator entry when instructions has an invalid type", () => {
    expect(
      PaseoConfigRawSchema.parse({
        metadataGeneration: {
          branchName: { instructions: 42 },
        },
      }),
    ).toEqual({
      metadataGeneration: {
        branchName: {},
      },
    });
  });
});
