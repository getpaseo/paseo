import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  composePromptParts,
  listAgentDefinitionIds,
  loadAgentDefinition,
} from "./prompt-profiles.js";

describe("Paseo Agent definitions", () => {
  let paseoHome: string;
  let agentsDir: string;
  const tempDirs: string[] = [];

  beforeEach(() => {
    paseoHome = mkdtempSync(join(tmpdir(), "paseo-agent-profiles-"));
    agentsDir = join(paseoHome, "agents");
    mkdirSync(join(agentsDir, "fragments"), { recursive: true });
  });

  afterEach(() => {
    rmSync(paseoHome, { recursive: true, force: true });
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function writeAgent(name: string, content: string): void {
    writeFileSync(join(agentsDir, name), content);
  }

  it("parses frontmatter and lists only top-level markdown agents", () => {
    writeAgent(
      "orchestrator.md",
      `---
name: Orchestrator
description: Routes work
prompt: override
mcp: [paseo]
model: openrouter-main/test-model
tools: [read, paseo__list_agents]
permissions:
  - tool: paseo__archive_agent
    action: deny
projectContext: true
---
Agent body.
`,
    );
    writeAgent("notes.txt", "ignored");
    writeFileSync(join(agentsDir, "fragments", "piece.md"), "fragment");

    const agent = loadAgentDefinition(paseoHome, "orchestrator");

    expect(listAgentDefinitionIds(paseoHome)).toEqual(["orchestrator"]);
    expect(agent?.frontmatter).toMatchObject({
      name: "Orchestrator",
      description: "Routes work",
      prompt: "override",
      mcp: ["paseo"],
      model: "openrouter-main/test-model",
      tools: ["read", "paseo__list_agents"],
      permissions: [{ tool: "paseo__archive_agent", action: "deny" }],
      projectContext: true,
    });
    expect(agent?.composedPrompt.customPrompt).toBe("Agent body.");
  });

  it("defaults to extend prompt mode", () => {
    writeAgent("worker.md", "Body.");

    const agent = loadAgentDefinition(paseoHome, "worker.md");

    expect(agent?.frontmatter.prompt).toBe("extend");
    expect(agent?.body).toBe("Body.");
    expect(agent?.composedPrompt.appendSystemPrompt).toEqual(["Body."]);
  });

  it("resolves bang-brace partials in place relative to the current file", () => {
    mkdirSync(join(agentsDir, "team", "partials"), { recursive: true });
    writeFileSync(join(agentsDir, "team", "partials", "style.md"), "Use short answers.");
    writeFileSync(join(agentsDir, "team", "nested.md"), "nested !{{./partials/style.md}}");
    writeAgent("inline.md", "Before\n!{{./team/nested.md}}\nAfter");

    expect(loadAgentDefinition(paseoHome, "inline")?.body).toBe(
      "Before\nnested Use short answers.\nAfter",
    );
  });

  it("rejects frontmatter inside partials", () => {
    writeFileSync(join(agentsDir, "fragments", "bad.md"), "---\nname: Nope\n---\nfragment");
    writeAgent("agent.md", "!{{./fragments/bad.md}}");

    expect(() => loadAgentDefinition(paseoHome, "agent")).toThrow(/partials cannot declare/i);
  });

  it("detects partial cycles", () => {
    writeFileSync(join(agentsDir, "fragments", "a.md"), "!{{./b.md}}");
    writeFileSync(join(agentsDir, "fragments", "b.md"), "!{{./a.md}}");
    writeAgent("cycle.md", "!{{./fragments/a.md}}");

    expect(() => loadAgentDefinition(paseoHome, "cycle")).toThrow(/cycle/i);
  });

  it("rejects missing partials and path escapes", () => {
    writeAgent("missing.md", "!{{./fragments/nope.md}}");
    writeAgent("escape.md", "!{{../secret.md}}");

    expect(() => loadAgentDefinition(paseoHome, "missing")).toThrow(/not found/i);
    expect(() => loadAgentDefinition(paseoHome, "escape")).toThrow(/escape|invalid/i);
    expect(() => loadAgentDefinition(paseoHome, "../escape")).toThrow(/invalid/i);
  });

  it("rejects symlink escapes for agents and partials", () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "paseo-agent-profile-outside-"));
    tempDirs.push(outsideDir);
    writeFileSync(join(outsideDir, "secret.md"), "outside secret");
    symlinkSync(join(outsideDir, "secret.md"), join(agentsDir, "linked-profile.md"));
    symlinkSync(join(outsideDir, "secret.md"), join(agentsDir, "fragments", "linked.md"));
    writeAgent("include-link.md", "!{{./fragments/linked.md}}");

    expect(() => loadAgentDefinition(paseoHome, "linked-profile")).toThrow(/escapes/i);
    expect(() => loadAgentDefinition(paseoHome, "include-link")).toThrow(/escapes/i);
  });

  it("enforces depth and total size caps", () => {
    writeFileSync(join(agentsDir, "fragments", "deep.md"), "!{{./deeper.md}}");
    writeFileSync(join(agentsDir, "fragments", "deeper.md"), "done");
    writeAgent("depth.md", "!{{./fragments/deep.md}}");
    writeAgent("large.md", "0123456789");

    expect(() => loadAgentDefinition(paseoHome, "depth", { maxDepth: 1 })).toThrow(/depth/i);
    expect(() => loadAgentDefinition(paseoHome, "large", { maxTotalBytes: 4 })).toThrow(/bytes/i);
  });

  it("orders agent append, session prompt, and daemon append with daemon last", () => {
    writeAgent("extend.md", "Agent prompt.");
    const agent = loadAgentDefinition(paseoHome, "extend");

    expect(
      composePromptParts({
        agent,
        systemPrompt: "  Session prompt.  ",
        daemonAppendSystemPrompt: "Daemon prompt.",
      }),
    ).toEqual({
      appendSystemPrompt: ["Agent prompt.", "Session prompt.", "Daemon prompt."],
    });
  });

  it("uses override agent body as custom prompt while appending session and daemon prompts", () => {
    writeAgent(
      "override.md",
      `---
prompt: override
---
Replacement base.
`,
    );
    const agent = loadAgentDefinition(paseoHome, "override");

    expect(
      composePromptParts({
        agent,
        systemPrompt: "Session prompt.",
        daemonAppendSystemPrompt: "Daemon prompt.",
      }),
    ).toEqual({
      customPrompt: "Replacement base.",
      appendSystemPrompt: ["Session prompt.", "Daemon prompt."],
    });
  });
});
