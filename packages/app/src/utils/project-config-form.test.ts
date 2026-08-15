import { describe, expect, it } from "vitest";
import { PaseoConfigRawSchema } from "@getpaseo/protocol/paseo-config-schema";
import type { PaseoConfigRaw } from "@getpaseo/protocol/messages";
import {
  applyDraftToConfig,
  configToDraft,
  createEmptyCommandDraft,
  type ProjectConfigDraft,
} from "./project-config-form";

function emptyDraft(): ProjectConfigDraft {
  return {
    setup: createEmptyCommandDraft(),
    teardown: createEmptyCommandDraft(),
    scripts: [],
    metadataPrompts: {
      branchName: "",
      commitMessage: "",
      pullRequest: "",
    },
    metadataGenerationBase: undefined,
  };
}

describe("configToDraft", () => {
  it("returns an empty draft for null config", () => {
    expect(configToDraft(null)).toEqual(emptyDraft());
  });

  it("renders a string lifecycle command as a single textarea text and remembers the kind", () => {
    const draft = configToDraft({
      worktree: { setup: "npm install" },
    });
    expect(draft.setup.text).toBe("npm install");
    expect(draft.setup.originalKind).toBe("string");
    expect(draft.teardown.text).toBe("");
    expect(draft.teardown.originalKind).toBe("missing");
  });

  it("renders an array lifecycle command as newline-separated text", () => {
    const draft = configToDraft({
      worktree: { teardown: ["docker compose down", "rm -rf .cache"] },
    });
    expect(draft.teardown.text).toBe("docker compose down\nrm -rf .cache");
    expect(draft.teardown.originalKind).toBe("array");
  });

  it("projects platform-specific lifecycle and script commands into separate fields", () => {
    const draft = configToDraft({
      worktree: {
        setup: {
          linux: ["npm ci", "npm run prepare"],
          win32: "npm.cmd ci",
        },
      },
      scripts: {
        dev: {
          command: {
            linux: "npm run dev",
            darwin: "npm run dev:mac",
            win32: "npm.cmd run dev:win",
          },
        },
      },
    });

    expect(draft.setup.format).toBe("platform");
    expect(draft.setup.platforms.linux).toEqual({
      text: "npm ci\nnpm run prepare",
      originalKind: "array",
    });
    expect(draft.setup.platforms.win32).toEqual({
      text: "npm.cmd ci",
      originalKind: "string",
    });
    expect(draft.scripts[0]?.command).toMatchObject({
      format: "platform",
      platforms: {
        linux: { text: "npm run dev", originalKind: "string" },
        darwin: { text: "npm run dev:mac", originalKind: "string" },
        win32: { text: "npm.cmd run dev:win", originalKind: "string" },
      },
    });
  });

  it("converts a scripts record into draft rows with stable local ids", () => {
    const draft = configToDraft({
      scripts: {
        dev: { type: "long-running", command: "npm run dev", port: 3000 },
        build: { command: ["npm", "run", "build"] },
      },
    });
    expect(draft.scripts).toHaveLength(2);
    const [devRow, buildRow] = draft.scripts;
    expect(devRow.name).toBe("dev");
    expect(devRow.command.text).toBe("npm run dev");
    expect(devRow.command.originalKind).toBe("string");
    expect(devRow.type).toBe("long-running");
    expect(devRow.portText).toBe("3000");
    expect(devRow.id).toMatch(/^script-draft-\d+$/);
    expect(buildRow.name).toBe("build");
    expect(buildRow.command.text).toBe("npm\nrun\nbuild");
    expect(buildRow.command.originalKind).toBe("array");
    expect(buildRow.portText).toBe("");
    expect(buildRow.id).not.toBe(devRow.id);
  });
});

describe("applyDraftToConfig", () => {
  it("preserves the original string kind when editing an existing setup field", () => {
    const base: PaseoConfigRaw = { worktree: { setup: "npm install" } };
    const draft = configToDraft(base);
    draft.setup.text = "npm install\nnpm run prepare";
    const next = applyDraftToConfig({ draft, base });
    expect(next.worktree?.setup).toBe("npm install\nnpm run prepare");
  });

  it("preserves the original array kind when editing an existing teardown field", () => {
    const base: PaseoConfigRaw = {
      worktree: { teardown: ["docker compose down"] },
    };
    const draft = configToDraft(base);
    draft.teardown.text = "docker compose down\nrm -rf .cache";
    const next = applyDraftToConfig({ draft, base });
    expect(next.worktree?.teardown).toEqual(["docker compose down", "rm -rf .cache"]);
  });

  it("round-trips platform-specific setup and script commands", () => {
    const base = PaseoConfigRawSchema.parse({
      worktree: {
        setup: {
          linux: ["npm ci", "npm run prepare"],
          win32: "npm.cmd ci",
        },
        teardown: { darwin: ["npm run clean"] },
      },
      scripts: {
        dev: {
          command: {
            linux: "npm run dev",
            win32: "npm.cmd run dev:win",
          },
        },
      },
    });

    const draft = configToDraft(base);
    const next = applyDraftToConfig({ draft, base });

    expect(next.worktree).toEqual(base.worktree);
    expect(next.scripts).toEqual(base.scripts);
  });

  it("keeps multiline platform script commands as strings", () => {
    const draft = configToDraft({
      scripts: {
        dev: { command: { linux: "npm run dev" } },
      },
    });
    const script = draft.scripts[0];
    if (!script) throw new Error("expected dev script");
    script.command.platforms.linux.text = "npm run dev\n--watch";

    const next = applyDraftToConfig({ draft, base: {} });

    expect(next.scripts?.dev?.command).toEqual({ linux: "npm run dev\n--watch" });
    expect(PaseoConfigRawSchema.parse(next)).toEqual(next);
  });

  it("preserves legacy script command objects when editing unrelated fields", () => {
    const base = PaseoConfigRawSchema.parse({
      scripts: {
        legacy: { command: { executable: "npm", args: ["run", "dev"] } },
      },
    });
    const draft = configToDraft(base);
    draft.metadataPrompts.branchName = "feat/<slug>";

    const next = applyDraftToConfig({ draft, base });

    expect(next.scripts?.legacy?.command).toEqual({
      executable: "npm",
      args: ["run", "dev"],
    });
  });

  it("writes a string for a newly added lifecycle field with one non-empty line", () => {
    const base: PaseoConfigRaw = {};
    const draft = configToDraft(base);
    draft.setup.text = "npm install";
    const next = applyDraftToConfig({ draft, base });
    expect(next.worktree?.setup).toBe("npm install");
  });

  it("writes an array for a newly added lifecycle field with multiple non-empty lines", () => {
    const base: PaseoConfigRaw = {};
    const draft = configToDraft(base);
    draft.setup.text = "npm install\nnpm run prepare";
    const next = applyDraftToConfig({ draft, base });
    expect(next.worktree?.setup).toEqual(["npm install", "npm run prepare"]);
  });

  it("omits a lifecycle field whose draft text is empty", () => {
    const base: PaseoConfigRaw = { worktree: { setup: "npm install" } };
    const draft = configToDraft(base);
    draft.setup.text = "";
    const next = applyDraftToConfig({ draft, base });
    expect(next.worktree?.setup).toBeUndefined();
  });

  it("preserves unknown top-level, worktree, and script entry fields on round-trip", () => {
    const base = PaseoConfigRawSchema.parse({
      worktree: {
        setup: "npm install",
        terminals: [{ name: "dev", command: "npm run dev" }],
        customWorktreeField: "keep",
      },
      scripts: {
        dev: {
          type: "long-running",
          command: "npm run dev",
          port: 3000,
          customScriptField: { nested: true },
        },
      },
      customTopLevel: "preserved",
    });

    const draft = configToDraft(base);
    const next = applyDraftToConfig({ draft, base });

    expect((next as Record<string, unknown>).customTopLevel).toBe("preserved");
    expect((next.worktree as Record<string, unknown>).customWorktreeField).toBe("keep");
    expect((next.worktree as Record<string, unknown>).terminals).toEqual([
      { name: "dev", command: "npm run dev" },
    ]);
    const devEntry = (next.scripts ?? {}).dev as Record<string, unknown>;
    expect(devEntry.customScriptField).toEqual({ nested: true });
  });

  it("preserves all scripts on round-trip, including ones never edited in this session", () => {
    const base = PaseoConfigRawSchema.parse({
      scripts: {
        dev: { type: "long-running", command: "npm run dev", port: 3000, customDevField: "keep" },
        build: { command: ["npm", "run", "build"], customBuildField: { nested: 1 } },
        lint: { command: "npm run lint", type: "task" },
      },
    });

    const draft = configToDraft(base);
    // Edit only "dev". Leave "build" and "lint" untouched.
    const devRow = draft.scripts.find((row) => row.name === "dev");
    if (!devRow) throw new Error("expected dev row in draft");
    devRow.command.text = "npm run dev -- --watch";

    const next = applyDraftToConfig({ draft, base });
    const scripts = next.scripts ?? {};
    expect(Object.keys(scripts).sort()).toEqual(["build", "dev", "lint"]);

    const devEntry = scripts.dev as Record<string, unknown>;
    expect(devEntry.command).toBe("npm run dev -- --watch");
    expect(devEntry.type).toBe("long-running");
    expect(devEntry.port).toBe(3000);
    expect(devEntry.customDevField).toBe("keep");

    const buildEntry = scripts.build as Record<string, unknown>;
    expect(buildEntry.command).toEqual(["npm", "run", "build"]);
    expect(buildEntry.customBuildField).toEqual({ nested: 1 });

    const lintEntry = scripts.lint as Record<string, unknown>;
    expect(lintEntry.command).toBe("npm run lint");
    expect(lintEntry.type).toBe("task");
  });

  it("normalizes script command text into the original command kind", () => {
    const base = PaseoConfigRawSchema.parse({
      scripts: {
        build: { command: ["npm", "run", "build"] },
      },
    });
    const draft = configToDraft(base);
    const buildRow = draft.scripts[0];
    buildRow.command.text = "npm run build";
    const next = applyDraftToConfig({ draft, base });
    const buildEntry = (next.scripts ?? {}).build as Record<string, unknown>;
    expect(buildEntry.command).toEqual(["npm run build"]);
  });

  it("parses script port as a number when numeric and writes string for non-numeric input", () => {
    const base = PaseoConfigRawSchema.parse({});
    const draft = configToDraft(base);
    draft.scripts = [
      {
        id: "row-1",
        name: "dev",
        command: { ...createEmptyCommandDraft(), text: "npm run dev" },
        type: "long-running",
        portText: "3000",
        rawEntry: {},
      },
      {
        id: "row-2",
        name: "tunnel",
        command: { ...createEmptyCommandDraft(), text: "ngrok" },
        type: "long-running",
        portText: "auto",
        rawEntry: {},
      },
    ];
    const next = applyDraftToConfig({ draft, base });
    const dev = (next.scripts ?? {}).dev as Record<string, unknown>;
    const tunnel = (next.scripts ?? {}).tunnel as Record<string, unknown>;
    expect(dev.port).toBe(3000);
    expect(tunnel.port).toBe("auto");
  });

  it("reads metadata prompt instructions for visible keys", () => {
    const draft = configToDraft({
      metadataGeneration: {
        branchName: { instructions: "feat/<slug>" },
        commitMessage: { instructions: "Conventional commits." },
        pullRequest: { instructions: "Include risk notes." },
      },
    });
    expect(draft.metadataPrompts).toEqual({
      branchName: "feat/<slug>",
      commitMessage: "Conventional commits.",
      pullRequest: "Include risk notes.",
    });
  });

  it("defaults metadata prompts to empty strings when not present", () => {
    const draft = configToDraft({
      metadataGeneration: { branchName: { instructions: "feat/<slug>" } },
    });
    expect(draft.metadataPrompts).toEqual({
      branchName: "feat/<slug>",
      commitMessage: "",
      pullRequest: "",
    });
  });

  it("does not expose legacy agentTitle as a metadata prompt", () => {
    const draft = configToDraft(
      PaseoConfigRawSchema.parse({
        metadataGeneration: {
          agentTitle: { instructions: "Use mb/." },
          branchName: { instructions: "feat/<slug>" },
        },
      }),
    );

    expect(draft.metadataPrompts).toEqual({
      branchName: "feat/<slug>",
      commitMessage: "",
      pullRequest: "",
    });
  });

  it("writes only metadata prompt entries with non-empty text", () => {
    const base: PaseoConfigRaw = {};
    const draft = configToDraft(base);
    draft.metadataPrompts.branchName = "Use mb/.";
    draft.metadataPrompts.commitMessage = "Conventional commits.";
    const next = applyDraftToConfig({ draft, base });
    expect(next.metadataGeneration).toEqual({
      branchName: { instructions: "Use mb/." },
      commitMessage: { instructions: "Conventional commits." },
    });
  });

  it("drops the metadataGeneration field when all prompts are empty", () => {
    const base = PaseoConfigRawSchema.parse({
      metadataGeneration: {
        branchName: { instructions: "Use mb/." },
      },
    });
    const draft = configToDraft(base);
    draft.metadataPrompts.branchName = "";
    const next = applyDraftToConfig({ draft, base });
    expect(next.metadataGeneration).toBeUndefined();
  });

  it("preserves legacy and unknown sibling fields inside metadataGeneration on round-trip", () => {
    const base = PaseoConfigRawSchema.parse({
      metadataGeneration: {
        agentTitle: { instructions: "Use mb/." },
        futureField: 42,
      },
    });
    const draft = configToDraft(base);
    draft.metadataPrompts.branchName = "Use prefix mb/ on branches.";
    const next = applyDraftToConfig({ draft, base });
    const metadata = next.metadataGeneration as Record<string, unknown>;
    expect(metadata.agentTitle).toEqual({ instructions: "Use mb/." });
    expect(metadata.branchName).toEqual({ instructions: "Use prefix mb/ on branches." });
    expect(metadata.futureField).toBe(42);
  });

  it("preserves unknown fields inside a metadata prompt entry on round-trip", () => {
    const base = PaseoConfigRawSchema.parse({
      metadataGeneration: {
        branchName: { instructions: "Use mb/.", model: "haiku" },
      },
    });
    const draft = configToDraft(base);
    draft.metadataPrompts.branchName = "Updated.";
    const next = applyDraftToConfig({ draft, base });
    const metadata = next.metadataGeneration as Record<string, unknown>;
    expect(metadata.branchName).toEqual({ instructions: "Updated.", model: "haiku" });
  });

  it("clears instructions but preserves unknown sibling fields when text becomes empty", () => {
    const base = PaseoConfigRawSchema.parse({
      metadataGeneration: {
        branchName: { instructions: "Use mb/.", model: "haiku" },
      },
    });
    const draft = configToDraft(base);
    draft.metadataPrompts.branchName = "";
    const next = applyDraftToConfig({ draft, base });
    const metadata = next.metadataGeneration as Record<string, unknown>;
    expect(metadata.branchName).toEqual({ model: "haiku" });
  });

  it("drops scripts with an empty name and removes scripts no longer present in the draft", () => {
    const base = PaseoConfigRawSchema.parse({
      scripts: {
        dev: { command: "npm run dev" },
        build: { command: "npm run build" },
      },
    });
    const draft = configToDraft(base);
    // remove build, add a row with empty name.
    draft.scripts = draft.scripts
      .filter((row) => row.name !== "build")
      .concat({
        id: "row-empty",
        name: "   ",
        command: { ...createEmptyCommandDraft(), text: "echo hi" },
        type: "",
        portText: "",
        rawEntry: {},
      });
    const next = applyDraftToConfig({ draft, base });
    const scripts = next.scripts ?? {};
    expect(Object.keys(scripts)).toEqual(["dev"]);
  });
});
