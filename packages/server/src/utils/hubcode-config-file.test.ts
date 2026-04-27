import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getWorktreeSetupCommands, getWorktreeTeardownCommands } from "./worktree.js";
import {
  readHubcodeConfigForEdit,
  statHubcodeConfigPath,
  writeHubcodeConfigForEdit,
} from "./hubcode-config-file.js";

describe("hubcode config file substrate", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "hubcode-config-file-test-")));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns null config and revision when hubcode.json is missing", () => {
    const result = readHubcodeConfigForEdit(tempDir);

    expect(result).toEqual({ ok: true, config: null, revision: null });
  });

  it("returns invalid_project_config for invalid JSON", () => {
    writeFileSync(join(tempDir, "hubcode.json"), "{ invalid json\n");

    const result = readHubcodeConfigForEdit(tempDir);

    expect(result).toEqual({
      ok: false,
      error: { code: "invalid_project_config" },
    });
  });

  it("preserves raw lifecycle string and array forms with a revision token", () => {
    writeFileSync(
      join(tempDir, "hubcode.json"),
      JSON.stringify({
        worktree: {
          setup: "npm install",
          teardown: ["npm run clean", "npm run reset"],
        },
      }),
    );

    const result = readHubcodeConfigForEdit(tempDir);

    expect(result).toEqual({
      ok: true,
      config: {
        worktree: {
          setup: "npm install",
          teardown: ["npm run clean", "npm run reset"],
        },
      },
      revision: statHubcodeConfigPath(tempDir),
    });
  });

  it("keeps runtime lifecycle commands normalized for execution", () => {
    writeFileSync(
      join(tempDir, "hubcode.json"),
      JSON.stringify({
        worktree: {
          setup: "npm install",
          teardown: ["npm run clean", "", 42, "npm run reset"],
        },
      }),
    );

    expect(getWorktreeSetupCommands(tempDir)).toEqual(["npm install"]);
    expect(getWorktreeTeardownCommands(tempDir)).toEqual(["npm run clean", "npm run reset"]);
  });

  it("writes pretty JSON with a trailing newline when revision matches", () => {
    writeFileSync(join(tempDir, "hubcode.json"), JSON.stringify({ worktree: { setup: "old" } }));
    const expectedRevision = statHubcodeConfigPath(tempDir);

    const result = writeHubcodeConfigForEdit({
      repoRoot: tempDir,
      config: { worktree: { setup: "npm install" } },
      expectedRevision,
    });

    expect(result).toEqual({
      ok: true,
      config: { worktree: { setup: "npm install" } },
      revision: statHubcodeConfigPath(tempDir),
    });
    expect(readFileSync(join(tempDir, "hubcode.json"), "utf8")).toBe(
      '{\n  "worktree": {\n    "setup": "npm install"\n  }\n}\n',
    );
  });

  it("rejects stale writes when the current revision changed before rename", () => {
    writeFileSync(join(tempDir, "hubcode.json"), JSON.stringify({ worktree: { setup: "old" } }));
    const expectedRevision = statHubcodeConfigPath(tempDir);
    writeFileSync(join(tempDir, "hubcode.json"), JSON.stringify({ worktree: { setup: "new" } }));
    const currentRevision = statHubcodeConfigPath(tempDir);

    const result = writeHubcodeConfigForEdit({
      repoRoot: tempDir,
      config: { worktree: { setup: "from editor" } },
      expectedRevision,
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "stale_project_config", currentRevision },
    });
    expect(readFileSync(join(tempDir, "hubcode.json"), "utf8")).toBe(
      JSON.stringify({ worktree: { setup: "new" } }),
    );
  });

  it("round-trips unknown top-level, worktree, and script-entry fields", () => {
    const config = {
      extraTop: { keep: true },
      worktree: {
        setup: ["npm install"],
        customWorktreeField: "preserve me",
      },
      scripts: {
        dev: {
          command: "npm run dev",
          type: "service",
          customScriptField: 123,
        },
      },
    };

    const result = writeHubcodeConfigForEdit({
      repoRoot: tempDir,
      config,
      expectedRevision: null,
    });

    expect(result).toEqual({
      ok: true,
      config,
      revision: statHubcodeConfigPath(tempDir),
    });
    expect(readHubcodeConfigForEdit(tempDir)).toEqual({
      ok: true,
      config,
      revision: statHubcodeConfigPath(tempDir),
    });
  });

  it("returns write_failed for filesystem write exceptions", () => {
    const fileRoot = join(tempDir, "not-a-directory");
    writeFileSync(fileRoot, "file");

    const result = writeHubcodeConfigForEdit({
      repoRoot: fileRoot,
      config: { worktree: { setup: "npm install" } },
      expectedRevision: null,
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "write_failed" },
    });
  });

  it("creates hubcode.json when the file is still missing and expected revision is null", () => {
    mkdirSync(join(tempDir, "nested"));

    const result = writeHubcodeConfigForEdit({
      repoRoot: join(tempDir, "nested"),
      config: { scripts: { dev: { command: "npm run dev" } } },
      expectedRevision: null,
    });

    expect(result).toEqual({
      ok: true,
      config: { scripts: { dev: { command: "npm run dev" } } },
      revision: statHubcodeConfigPath(join(tempDir, "nested")),
    });
  });
});
