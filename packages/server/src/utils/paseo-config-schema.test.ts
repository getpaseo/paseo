import { describe, expect, it } from "vitest";
import { PaseoConfigRawSchema, PaseoConfigSchema } from "./paseo-config-schema.js";

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

  it("parses all metadata generation instruction entries", () => {
    expect(
      PaseoConfigSchema.parse({
        metadataGeneration: {
          agentTitle: { instructions: "Use concise titles." },
          branchName: { instructions: "Prefix branches with feat/." },
          commitMessage: { instructions: "Use imperative mood." },
          pullRequest: { instructions: "Include risk notes." },
        },
      }),
    ).toEqual({
      metadataGeneration: {
        agentTitle: { instructions: "Use concise titles." },
        branchName: { instructions: "Prefix branches with feat/." },
        commitMessage: { instructions: "Use imperative mood." },
        pullRequest: { instructions: "Include risk notes." },
      },
    });
  });

  it("parses partial metadata generation instructions with missing entries undefined", () => {
    const parsed = PaseoConfigSchema.parse({
      metadataGeneration: {
        agentTitle: { instructions: "Keep it short." },
      },
    });

    expect(parsed.metadataGeneration).toEqual({
      agentTitle: { instructions: "Keep it short." },
    });
    expect(parsed.metadataGeneration?.branchName).toBeUndefined();
    expect(parsed.metadataGeneration?.commitMessage).toBeUndefined();
    expect(parsed.metadataGeneration?.pullRequest).toBeUndefined();
  });

  it("passes through unknown metadata generation fields", () => {
    expect(
      PaseoConfigSchema.parse({
        metadataGeneration: {
          agentTitle: { instructions: "Use concise titles." },
          futureField: 42,
        },
      }),
    ).toEqual({
      metadataGeneration: {
        agentTitle: { instructions: "Use concise titles." },
        futureField: 42,
      },
    });
  });

  it("passes through unknown metadata generator entry fields", () => {
    expect(
      PaseoConfigSchema.parse({
        metadataGeneration: {
          agentTitle: {
            instructions: "Use concise titles.",
            model: "haiku",
          },
        },
      }),
    ).toEqual({
      metadataGeneration: {
        agentTitle: {
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
          agentTitle: { instructions: 42 },
        },
      }),
    ).toEqual({
      metadataGeneration: {
        agentTitle: {},
      },
    });
  });

  it("raw schema preserves old-style config while accepting metadata generation", () => {
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
      },
    };

    expect(PaseoConfigRawSchema.parse(config)).toEqual(config);
  });

  it("raw schema falls back to an empty metadata generator entry when instructions has an invalid type", () => {
    expect(
      PaseoConfigRawSchema.parse({
        metadataGeneration: {
          agentTitle: { instructions: 42 },
        },
      }),
    ).toEqual({
      metadataGeneration: {
        agentTitle: {},
      },
    });
  });
});
