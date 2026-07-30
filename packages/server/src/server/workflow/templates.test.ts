import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { materializeWorkflowSpec, validateWorkflowTemplate } from "./spec.js";

const templatesDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "templates");

describe("built-in workflow templates", () => {
  it("ships goal, reviewed-goal, research-project, and echo-demo as valid JSON data", async () => {
    const files = (await fs.readdir(templatesDirectory)).filter((name) => name.endsWith(".json"));
    expect(files.sort()).toEqual([
      "echo-demo.json",
      "goal.json",
      "research-project.json",
      "reviewed-goal.json",
    ]);
    for (const file of files) {
      const value = JSON.parse(await fs.readFile(path.join(templatesDirectory, file), "utf8"));
      expect(validateWorkflowTemplate(value), file).toMatchObject({ valid: true, issues: [] });
    }
  });

  it("materializes every built-in using canonical JSON and contextual defaults", async () => {
    const values: Record<string, Record<string, unknown>> = {
      "echo-demo": {},
      goal: { objective: "Complete a sanitized fixture." },
      "reviewed-goal": { objective: "Complete and review a sanitized fixture." },
      "research-project": {
        objective: "Compare two sanitized approaches.",
        branchName: "workflow-research-fixture",
      },
    };
    for (const [name, parameters] of Object.entries(values)) {
      const template = JSON.parse(
        await fs.readFile(path.join(templatesDirectory, `${name}.json`), "utf8"),
      );
      const result = materializeWorkflowSpec(template, parameters, {
        workspaceId: "workspace-1",
        worktreePath: "/repo",
        agentId: "agent-1",
      });
      expect(JSON.parse(result.canonicalJson)).toEqual(result.spec);
      expect(result.spec).not.toHaveProperty("parameters");
    }
  });
});
