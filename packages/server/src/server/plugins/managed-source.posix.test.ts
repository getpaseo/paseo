import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runGitCommand } from "../../utils/run-git-command.js";
import { ManagedPluginSources } from "./managed-source.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createRepository(): Promise<string> {
  const repository = await mkdtemp(path.join(tmpdir(), "paseo-plugin-git-repository-"));
  roots.push(repository);
  await runGitCommand(["init", "-b", "main"], { cwd: repository });
  await runGitCommand(["config", "user.name", "Paseo Tests"], { cwd: repository });
  await runGitCommand(["config", "user.email", "paseo@example.test"], { cwd: repository });
  await writeFile(
    path.join(repository, "paseo-plugin.json"),
    JSON.stringify({ id: "managed-example" }),
  );
  await writeFile(path.join(repository, "index.server.ts"), "export default () => () => {};\n");
  await commitAll(repository, "initial");
  return repository;
}

async function commitAll(repository: string, message: string): Promise<string> {
  await runGitCommand(["add", "-A"], { cwd: repository });
  await runGitCommand(["commit", "-m", message], { cwd: repository });
  const { stdout } = await runGitCommand(["rev-parse", "HEAD"], { cwd: repository });
  return stdout.trim();
}

describe("managed Git plugin sources", () => {
  it("does not expose Git URL credentials when cloning fails", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-plugin-git-home-"));
    roots.push(home);
    const sources = new ManagedPluginSources(home);

    const failure = sources.prepareInstall({
      source: "https://oauth2:super-secret@127.0.0.1:1/missing.git",
    });
    await expect(failure).rejects.not.toThrow(/oauth2|super-secret/);
  });

  it("tracks branches, prepares updates, persists commits, and keeps tags pinned", async () => {
    const repository = await createRepository();
    const home = await mkdtemp(path.join(tmpdir(), "paseo-plugin-git-home-"));
    roots.push(home);
    const remote = pathToFileURL(repository).href;
    const sources = new ManagedPluginSources(home);

    let candidate = await sources.prepareInstall({ source: remote });
    expect(candidate.defaultId).toBe("managed-example");
    candidate = await sources.place("managed-example", candidate);
    sources.commit("managed-example", candidate.record);

    const initial = candidate.record.commit;
    await writeFile(
      path.join(repository, "index.server.ts"),
      "export default () => () => { new Date(); };\n",
    );
    const latest = await commitAll(repository, "update");
    const status = await sources.status("managed-example", candidate.directory);
    expect(status).toMatchObject({
      currentCommit: initial,
      latestCommit: latest,
      commitsBehind: 1,
      updateAvailable: true,
    });

    const prepared = await sources.prepareUpdate("managed-example", candidate.directory);
    expect(prepared.commits).toBe(1);
    if (!prepared.candidate) throw new Error("Expected an update candidate");
    const updated = await sources.place("managed-example", prepared.candidate);
    sources.commit("managed-example", updated.record);
    expect(await readFile(path.join(updated.directory, "index.server.ts"), "utf8")).toContain(
      "new Date",
    );
    expect(new ManagedPluginSources(home).get("managed-example")?.commit).toBe(latest);

    await runGitCommand(["tag", "v1", initial], { cwd: repository });
    let pinned = await sources.prepareInstall({ source: remote, ref: "v1" });
    pinned = await sources.place("pinned-example", pinned);
    sources.commit("pinned-example", pinned.record);
    expect(await sources.status("pinned-example", pinned.directory)).toMatchObject({
      currentCommit: initial,
      latestCommit: initial,
      commitsBehind: 0,
      updateAvailable: false,
    });
  }, 30_000);
});
