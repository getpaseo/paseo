import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import type { CommandOptions, SingleResult, OutputSchema } from "../../output/index.js";

export interface SkillsNewOptions extends CommandOptions {
  dir?: string;
  description?: string;
  force?: boolean;
}

interface SkillNewRow {
  path: string;
  status: string;
}

const schema: OutputSchema<SkillNewRow> = {
  idField: "path",
  columns: [
    { header: "PATH", field: "path", width: 60 },
    { header: "STATUS", field: "status", width: 10, color: () => "green" },
  ],
};

const TEMPLATE = (name: string, description: string) =>
  `---
name: ${name}
description: ${description}
---

# ${name}

## When to use

Describe the situations in which the agent should load this skill.

## What it does

Explain the actions, transformations, or guidance the skill provides.

## Examples

\`\`\`text
User: ...
Agent: ...
\`\`\`
`;

export async function runSkillsNewCommand(
  name: string,
  options: SkillsNewOptions,
  _command: Command,
): Promise<SingleResult<SkillNewRow>> {
  const baseDir = options.dir ?? process.cwd();
  const skillDir = resolve(baseDir, name);
  const skillFile = resolve(skillDir, "SKILL.md");

  if (existsSync(skillFile) && !options.force) {
    throw {
      code: "EXISTS",
      message: `${skillFile} already exists`,
      details: "Use --force to overwrite.",
    };
  }

  await mkdir(skillDir, { recursive: true });
  await writeFile(
    skillFile,
    TEMPLATE(name, options.description ?? "Short, action-oriented description."),
    "utf-8",
  );

  return {
    type: "single",
    data: { path: skillFile, status: "created" },
    schema,
  };
}
