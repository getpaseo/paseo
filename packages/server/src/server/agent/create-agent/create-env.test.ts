import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCreateAgentEnv } from "./create.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("resolveCreateAgentEnv", () => {
  it("adds project env and lets request-specific values override it", () => {
    const cwd = mkdtempSync(join(tmpdir(), "paseo-create-agent-env-"));
    temporaryDirectories.push(cwd);
    writeFileSync(
      join(cwd, "paseo.json"),
      JSON.stringify({ worktree: { env: { API_URL: "project", PROJECT_ONLY: "1" } } }),
    );

    expect(resolveCreateAgentEnv(cwd, { API_URL: "request", REQUEST_ONLY: "1" })).toEqual({
      API_URL: "request",
      PROJECT_ONLY: "1",
      REQUEST_ONLY: "1",
    });
  });

  it("leaves agent env undefined when neither source defines variables", () => {
    const cwd = mkdtempSync(join(tmpdir(), "paseo-create-agent-env-empty-"));
    temporaryDirectories.push(cwd);

    expect(resolveCreateAgentEnv(cwd, undefined)).toBeUndefined();
  });
});
