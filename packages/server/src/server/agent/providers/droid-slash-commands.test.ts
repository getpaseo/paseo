import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { listDroidSlashCommands } from "./droid-slash-commands.js";

function tmpPath(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

describe("listDroidSlashCommands", () => {
  let tempHome: string;
  let repoRoot: string;
  let nestedCwd: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    tempHome = tmpPath("droid-home-");
    repoRoot = tmpPath("droid-repo-");
    nestedCwd = path.join(repoRoot, "apps", "mobile");

    mkdirSync(nestedCwd, { recursive: true });
    execSync("git init -b main", { cwd: repoRoot, stdio: "ignore" });
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }

    rmSync(tempHome, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  });

  test("merges base commands, built-ins, workspace skills, legacy commands, and personal skills", async () => {
    mkdirSync(path.join(repoRoot, ".factory", "skills", "review"), { recursive: true });
    writeFileSync(
      path.join(repoRoot, ".factory", "skills", "review", "SKILL.md"),
      [
        "---",
        "name: review",
        "description: Workspace review skill",
        "user-invocable: true",
        "---",
        "",
        "Review the current change.",
        "",
      ].join("\n"),
      "utf8",
    );

    mkdirSync(path.join(repoRoot, ".factory", "skills", "hidden-context"), { recursive: true });
    writeFileSync(
      path.join(repoRoot, ".factory", "skills", "hidden-context", "SKILL.md"),
      [
        "---",
        "name: hidden-context",
        "description: Hidden helper",
        "user-invocable: false",
        "---",
        "",
        "Should not appear.",
        "",
      ].join("\n"),
      "utf8",
    );

    mkdirSync(path.join(repoRoot, ".factory", "commands"), { recursive: true });
    writeFileSync(
      path.join(repoRoot, ".factory", "commands", "Prepare Release.md"),
      [
        "---",
        "description: Prepare the release branch",
        "argument-hint: VERSION=<semver>",
        "---",
        "",
        "Prepare the release.",
        "",
      ].join("\n"),
      "utf8",
    );

    mkdirSync(path.join(repoRoot, ".agent", "skills", "legacy-skill"), { recursive: true });
    writeFileSync(
      path.join(repoRoot, ".agent", "skills", "legacy-skill", "SKILL.md"),
      ["---", "description: Legacy workspace skill", "---", "", "Legacy instructions.", ""].join(
        "\n",
      ),
      "utf8",
    );

    mkdirSync(path.join(nestedCwd, ".factory", "skills", "review"), { recursive: true });
    writeFileSync(
      path.join(nestedCwd, ".factory", "skills", "review", "SKILL.md"),
      [
        "---",
        "name: review",
        "description: Nested workspace review skill",
        "user-invocable: true",
        "---",
        "",
        "Prefer this description.",
        "",
      ].join("\n"),
      "utf8",
    );

    mkdirSync(path.join(tempHome, ".factory", "skills", "personal-skill"), { recursive: true });
    writeFileSync(
      path.join(tempHome, ".factory", "skills", "personal-skill", "SKILL.md"),
      [
        "---",
        "description: >",
        "  Personal skill",
        "  with wrapped details",
        "---",
        "",
        "Personal instructions.",
        "",
      ].join("\n"),
      "utf8",
    );

    const commands = await listDroidSlashCommands(nestedCwd, [
      {
        name: "help",
        description: "Provider help overrides built-in help",
        argumentHint: "",
      },
    ]);

    expect(commands.some((command) => command.name === "skills")).toBe(true);
    expect(commands.some((command) => command.name === "mcp")).toBe(true);
    expect(commands.find((command) => command.name === "help")?.description).toBe(
      "Provider help overrides built-in help",
    );
    expect(commands.find((command) => command.name === "review")?.description).toBe(
      "Nested workspace review skill",
    );
    expect(commands.find((command) => command.name === "prepare-release")).toEqual({
      name: "prepare-release",
      description: "Prepare the release branch",
      argumentHint: "VERSION=<semver>",
    });
    expect(commands.find((command) => command.name === "legacy-skill")?.description).toBe(
      "Legacy workspace skill",
    );
    expect(commands.find((command) => command.name === "personal-skill")?.description).toBe(
      "Personal skill with wrapped details",
    );
    expect(commands.some((command) => command.name === "hidden-context")).toBe(false);
  });
});
