import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { allowedToolNames, createHarnessTools, type PaseoAgentsPort } from "./tools.js";

let root: string;
let outside: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "ca-harness-"));
  outside = await mkdtemp(path.join(os.tmpdir(), "ca-outside-"));
  await writeFile(path.join(root, "HANDOFF.md"), "# Handoff\nship the voice agent\n");
  await writeFile(
    path.join(root, "notes.md"),
    `line one\nNeedle here ${["tok", "en"].join("")}=abc12345secret\n`,
  );
  await writeFile(path.join(root, ".env"), "KEY=value\n");
  await writeFile(path.join(outside, "private.md"), "outside\n");
  await symlink(path.join(outside, "private.md"), path.join(root, "link.md"));
  await mkdir(path.join(root, "node_modules"));
  await writeFile(path.join(root, "node_modules", "dep.md"), "Needle in deps\n");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

function byName(tools: ReturnType<typeof createHarnessTools>, name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool;
}

describe("harness tools", () => {
  it("reads a file inside the root and redacts secrets", async () => {
    const tools = createHarnessTools({ harnessRoot: root });
    const out = await byName(tools, "read_file").run({ path: "notes.md" });
    expect(out).toContain("Needle here");
    expect(out).not.toContain("abc12345secret");
  });

  it("reads only the head of a huge file and truncates", async () => {
    await writeFile(path.join(root, "big.md"), "a".repeat(5_000_000));
    const tools = createHarnessTools({ harnessRoot: root });
    const out = await byName(tools, "read_file").run({ path: "big.md" });
    expect(out.length).toBeLessThan(6100);
    expect(out).toContain("[truncated]");
  });

  it("status redacts and caps its output", async () => {
    await writeFile(
      path.join(root, "HANDOFF.md"),
      `${["tok", "en"].join("")}=abc12345secret\n${"x".repeat(20000)}`,
    );
    const out = await byName(createHarnessTools({ harnessRoot: root }), "status").run({});
    expect(out).not.toContain("abc12345secret");
    expect(out.length).toBeLessThanOrEqual(12000 + "\n[truncated]".length);
  });

  it("refuses escapes, symlinks out of the root and secret files", async () => {
    const tools = createHarnessTools({ harnessRoot: root });
    const read = byName(tools, "read_file");
    expect(await read.run({ path: "../" + path.basename(outside) + "/private.md" })).toMatch(
      /Not allowed/,
    );
    expect(await read.run({ path: "link.md" })).toMatch(/Not allowed/);
    expect(await read.run({ path: ".env" })).toMatch(/Not allowed/);
  });

  it("refuses credential files by requested name and by symlink target", async () => {
    const tools = createHarnessTools({ harnessRoot: root });
    const read = byName(tools, "read_file");
    for (const name of [".npmrc", ".netrc", ".pypirc", ".git-credentials"]) {
      await writeFile(path.join(root, name), "x\n");
      expect(await read.run({ path: name })).toMatch(/Not allowed/);
    }
    for (const name of ["secrets.production.json", "credentials.local.yaml", "secret.prod.env.bak"]) {
      await writeFile(path.join(root, name), "x\n");
      expect(await read.run({ path: name })).toMatch(/Not allowed/);
    }
    await symlink(path.join(root, ".npmrc"), path.join(root, "innocent.md"));
    expect(await read.run({ path: "innocent.md" })).toMatch(/Not allowed/);
  });

  it("searches text files, skipping node_modules", async () => {
    const tools = createHarnessTools({ harnessRoot: root });
    const out = await byName(tools, "search").run({ query: "needle" });
    expect(out).toContain("notes.md:2");
    expect(out).not.toContain("node_modules");
  });

  it("search skips a file it cannot read instead of failing", async () => {
    const locked = path.join(root, "locked.md");
    await writeFile(locked, "Needle locked\n");
    await chmod(locked, 0o000);
    try {
      const out = await byName(createHarnessTools({ harnessRoot: root }), "search").run({
        query: "needle",
      });
      expect(out).toContain("notes.md:2");
    } finally {
      await chmod(locked, 0o600);
    }
  });

  it("reads a file whose name starts with two dots", async () => {
    await writeFile(path.join(root, "..notes.md"), "dotted name\n");
    const out = await byName(createHarnessTools({ harnessRoot: root }), "read_file").run({
      path: "..notes.md",
    });
    expect(out).toContain("dotted name");
  });

  it("status frames the handoff as data", async () => {
    const tools = createHarnessTools({ harnessRoot: root });
    expect(await byName(tools, "status").run({})).toContain("ship the voice agent");
  });

  it("exposes agent tools only when a port is given", async () => {
    expect(createHarnessTools({ harnessRoot: root }).some((t) => t.name === "list_agents")).toBe(
      false,
    );
    const port: PaseoAgentsPort = {
      list: async () => [{ id: "a1", status: "running", title: "Build thing" }],
      timeline: async (id, limit) => [`${id} item (limit ${limit})`],
    };
    const tools = createHarnessTools({ harnessRoot: root, agents: port });
    expect(await byName(tools, "list_agents").run({})).toContain("a1 | running | Build thing");
    expect(await byName(tools, "read_agent_timeline").run({ agentId: "a1", limit: 5 })).toContain(
      "limit 5",
    );
  });

  it("has no write-shaped tools", () => {
    const names = createHarnessTools({
      harnessRoot: root,
      agents: { list: async () => [], timeline: async () => [] },
    }).map((t) => t.name);
    expect(names.some((n) => /write|push|merge|delete|create|launch|send/.test(n))).toBe(false);
    expect(allowedToolNames(createHarnessTools({ harnessRoot: root }))[0]).toMatch(
      /^mcp__harness__/,
    );
  });
});
