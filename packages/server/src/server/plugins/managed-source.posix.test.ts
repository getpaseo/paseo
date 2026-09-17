import { mkdir, rename, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
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
      source: "git:https://oauth2:super-secret@127.0.0.1:1/missing.git",
    });
    await expect(failure).rejects.not.toThrow(/oauth2|super-secret/);
  });

  it("normalizes explicit GitHub identifiers and shorthand to the same Git source", async () => {
    const repository = await createRepository();
    const home = await mkdtemp(path.join(tmpdir(), "paseo-plugin-github-home-"));
    roots.push(home);
    const overlay = {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.${pathToFileURL(repository).href}.insteadOf`,
      GIT_CONFIG_VALUE_0: "https://github.com/fixture/repository.git",
    };
    const previous = Object.fromEntries(Object.keys(overlay).map((key) => [key, process.env[key]]));
    Object.assign(process.env, overlay);
    try {
      const sources = new ManagedPluginSources(home);
      for (const source of [
        "github:fixture/repository",
        "fixture/repository",
        "git:fixture/repository",
      ]) {
        const candidate = await sources.prepareInstall({ source });
        expect(candidate.record).toMatchObject({
          kind: "git",
          remote: "https://github.com/fixture/repository.git",
        });
        await sources.discard(candidate);
      }
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 30_000);

  it("offers current default HEAD after installing a tag", async () => {
    const repository = await createRepository();
    const home = await mkdtemp(path.join(tmpdir(), "paseo-plugin-git-home-"));
    roots.push(home);
    const remote = pathToFileURL(repository).href;
    const sources = new ManagedPluginSources(home);

    let candidate = await sources.prepareInstall({ source: `git:${remote}` });
    expect(candidate.defaultId).toBe("managed-example");
    candidate = await sources.place("managed-example", candidate);
    sources.commit("managed-example", candidate.record);
    const metadataPath = path.join(home, "plugins", "sources.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    delete metadata["managed-example"].kind;
    Object.assign(metadata["managed-example"], {
      commit: "obsolete",
      requestedRef: "v0",
      trackingBranch: "missing",
      checkoutRoot: "/obsolete",
    });
    await writeFile(metadataPath, JSON.stringify(metadata));
    expect(
      await new ManagedPluginSources(home).describe("managed-example", candidate.directory),
    ).toMatchObject({ identity: { kind: "git", remote } });

    if (candidate.record.kind !== "git") throw new Error("Expected Git source");
    const initial = (await sources.describe("managed-example", candidate.directory))
      .currentRevision!;
    await writeFile(
      path.join(repository, "index.server.ts"),
      "export default () => () => { new Date(); };\n",
    );
    const latest = await commitAll(repository, "update");
    const status = await sources.status("managed-example", candidate.directory);
    expect(status).toMatchObject({
      currentCommit: initial,
      latestCommit: latest,
      updateAvailable: true,
    });

    const preview = await new ManagedPluginSources(home).preview(
      "managed-example",
      candidate.directory,
    );
    expect(preview.outcome).toBe("update");
    const prepared = await sources.prepareUpdate(preview.proposal!, candidate.directory);
    const updated = await sources.place("managed-example", prepared);
    sources.commit("managed-example", updated.record);
    expect(await readFile(path.join(updated.directory, "index.server.ts"), "utf8")).toContain(
      "new Date",
    );
    expect(
      await new ManagedPluginSources(home).describe("managed-example", updated.directory),
    ).toMatchObject({ currentRevision: latest });
    expect(JSON.parse(await readFile(metadataPath, "utf8"))["managed-example"]).toEqual({
      kind: "git",
      remote,
    });

    await runGitCommand(["tag", "v1", initial], { cwd: repository });
    let tagged = await sources.prepareInstall({ source: remote, ref: "v1" });
    tagged = await sources.place("tagged-example", tagged);
    sources.commit("tagged-example", tagged.record);
    expect(await sources.status("tagged-example", tagged.directory)).toMatchObject({
      currentCommit: initial,
      latestCommit: latest,
      updateAvailable: true,
    });
  }, 30_000);
  it("resolves branch, tag and commit installs against changed default HEAD and preserves the reviewed commit", async () => {
    const repository = await createRepository();
    const home = await mkdtemp(path.join(tmpdir(), "paseo-plugin-review-"));
    roots.push(home);
    const remote = pathToFileURL(repository).href;
    const initial = (await runGitCommand(["rev-parse", "HEAD"], { cwd: repository })).stdout.trim();
    await runGitCommand(["tag", "v1"], { cwd: repository });
    const sources = new ManagedPluginSources(home);
    const installations = [];
    for (const [index, ref] of [undefined, "main", "v1", initial].entries()) {
      const id = `review-${index}`;
      const candidate = await sources.place(
        id,
        await sources.prepareInstall({ source: remote, ref }),
      );
      sources.commit(id, candidate.record);
      installations.push({ id, candidate });
    }
    await runGitCommand(["checkout", "-b", "new-default"], { cwd: repository });
    await writeFile(path.join(repository, "revision.txt"), "reviewed");
    const reviewed = await commitAll(repository, "new default");
    const previews = await Promise.all(
      installations.map(({ id, candidate }) => sources.preview(id, candidate.directory)),
    );
    for (const preview of previews)
      expect(preview).toMatchObject({
        outcome: "update",
        current: { currentRevision: initial },
        target: { commit: reviewed },
      });
    await writeFile(path.join(repository, "revision.txt"), "moved after review");
    const moved = await commitAll(repository, "move again");
    const restarted = new ManagedPluginSources(home);
    const { id, candidate } = installations[0]!;
    const updated = await restarted.place(
      id,
      await restarted.prepareUpdate(previews[0]!.proposal!, candidate.directory),
    );
    expect(await restarted.describe(id, updated.directory)).toEqual({
      identity: previews[0]!.current!.identity,
      currentRevision: reviewed,
    });
    expect(await readFile(path.join(updated.directory, "revision.txt"), "utf8")).toBe("reviewed");
    expect(await restarted.preview(id, updated.directory)).toMatchObject({
      target: { commit: moved },
    });
    await expect(
      restarted.assertCurrent(previews[0]!.proposal!, updated.directory),
    ).rejects.toThrow("changed since review");
    const sameRevision = await restarted.place(
      id,
      await restarted.prepareInstall({ source: remote, ref: initial }),
    );
    await expect(
      restarted.assertCurrent(previews[0]!.proposal!, sameRevision.directory),
    ).rejects.toThrow("changed since review");
    expect(
      await restarted.preview(id, updated.directory, { kind: "git", ref: initial.slice(0, 8) }),
    ).toMatchObject({ target: { commit: initial } });
  }, 30_000);
  it("uses retained acquisition remote when credential rewriting changes origin, preserving nested identity", async () => {
    const repository = await createRepository();
    const nested = path.join(repository, "plugins", "review");
    await mkdir(nested, { recursive: true });
    for (const name of ["paseo-plugin.json", "index.server.ts"])
      await rename(path.join(repository, name), path.join(nested, name));
    await commitAll(repository, "nested plugin");
    await runGitCommand(["update-server-info"], { cwd: repository });
    const server = createServer((request, response) => {
      const pathname = new URL(request.url!, "http://localhost").pathname;
      const file = path.resolve(repository, ".git", `.${pathname}`);
      if (!file.startsWith(path.join(repository, ".git") + path.sep)) {
        response.writeHead(404).end();
        return;
      }
      try {
        response.end(readFileSync(file));
      } catch {
        response.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected HTTP port");
    const remote = `http://fixture:fake-secret@127.0.0.1:${address.port}/`;
    const home = await mkdtemp(path.join(tmpdir(), "paseo-plugin-credential-"));
    roots.push(home);
    try {
      const sources = new ManagedPluginSources(home);
      const candidate = await sources.place(
        "nested",
        await sources.prepareInstall({ source: remote, pluginPath: "plugins/review" }),
      );
      sources.commit("nested", candidate.record);
      expect(
        (
          await runGitCommand(["remote", "get-url", "origin"], { cwd: candidate.directory })
        ).stdout.trim(),
      ).toBe("https://paseo.invalid/plugin.git");
      const before = await sources.describe("nested", candidate.directory);
      expect(before.identity).toEqual({
        kind: "git",
        remote: `http://127.0.0.1:${address.port}/`,
        pluginPath: "plugins/review",
      });
      await writeFile(path.join(nested, "revision.txt"), "new");
      const latest = await commitAll(repository, "advance");
      await runGitCommand(["update-server-info"], { cwd: repository });
      const restarted = new ManagedPluginSources(home);
      const preview = await restarted.preview("nested", candidate.directory);
      expect(preview.target).toEqual({ kind: "git", commit: latest });
      const updated = await restarted.place(
        "nested",
        await restarted.prepareUpdate(preview.proposal!, candidate.directory),
      );
      expect(await restarted.describe("nested", updated.directory)).toEqual({
        identity: before.identity,
        currentRevision: latest,
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);
});
