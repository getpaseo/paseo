import { describe, expect, test } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  diffWorkspaceGitRefs,
  diffWorkspaceGitRemoteRefs,
  fetchWorkspaceGitRemote,
  parseWorkspaceGitRefs,
} from "./workspace-git-fetch.js";
import { runGitCommand, type RunGitCommand } from "../utils/run-git-command.js";

describe("workspace Git remote refs", () => {
  test("runs the complete fetch through the supplied Git runner", async () => {
    const commands: string[][] = [];
    let refRead = 0;
    const run: RunGitCommand = async (args, options) => {
      commands.push(args);
      if (args[0] === "fetch") {
        expect(options.envOverlay).toEqual({
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: "",
          GCM_INTERACTIVE: "0",
        });
      }
      const stdout =
        args[0] === "for-each-ref"
          ? `refs/remotes/origin/main\0${refRead++ === 0 ? "aaaaaaaa" : "bbbbbbbb"}`
          : "";
      return { stdout, stderr: "", truncated: false, exitCode: 0, signal: null };
    };

    await expect(
      fetchWorkspaceGitRemote("/repo", { onRefSnapshot() {} }, run),
    ).resolves.toMatchObject({
      changes: [
        {
          kind: "moved",
          ref: "origin/main",
          beforeOid: "aaaaaaaa",
          afterOid: "bbbbbbbb",
        },
      ],
    });
    expect(commands).toEqual([
      ["for-each-ref", "--format=%(refname)%00%(objectname)"],
      ["fetch", "origin", "--prune"],
      ["for-each-ref", "--format=%(refname)%00%(objectname)"],
    ]);
  });

  test("parses refs for semantic before/after comparison", () => {
    expect(
      parseWorkspaceGitRefs(
        [
          "refs/remotes/origin/main\0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "refs/remotes/upstream/topic\0bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "refs/heads/main\0cccccccccccccccccccccccccccccccccccccccc",
        ].join("\n"),
      ),
    ).toEqual(
      new Map([
        ["refs/remotes/origin/main", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
        ["refs/remotes/upstream/topic", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
        ["refs/heads/main", "cccccccccccccccccccccccccccccccccccccccc"],
      ]),
    );
  });

  test("distinguishes remote changes from concurrent local ref changes", () => {
    expect(
      diffWorkspaceGitRefs(
        new Map([
          ["refs/remotes/origin/main", "aaaaaaaa"],
          ["refs/heads/topic", "bbbbbbbb"],
        ]),
        new Map([
          ["refs/remotes/origin/main", "cccccccc"],
          ["refs/heads/topic", "dddddddd"],
        ]),
      ),
    ).toEqual({
      remoteChanges: [
        {
          kind: "moved",
          ref: "origin/main",
          beforeOid: "aaaaaaaa",
          afterOid: "cccccccc",
        },
      ],
      nonRemoteRefsChanged: true,
    });
  });

  test("reports added, changed, and deleted remote refs", () => {
    expect(
      diffWorkspaceGitRemoteRefs(
        new Map([
          ["origin/main", "aaaaaaaa"],
          ["origin/deleted", "bbbbbbbb"],
          ["origin/unchanged", "cccccccc"],
        ]),
        new Map([
          ["origin/main", "dddddddd"],
          ["origin/added", "eeeeeeee"],
          ["origin/unchanged", "cccccccc"],
        ]),
      ),
    ).toEqual([
      {
        kind: "moved",
        ref: "origin/main",
        beforeOid: "aaaaaaaa",
        afterOid: "dddddddd",
      },
      { kind: "added", ref: "origin/added", afterOid: "eeeeeeee" },
      { kind: "deleted", ref: "origin/deleted", beforeOid: "bbbbbbbb" },
    ]);
  });
});

// Serve a real bare repository over Git's dumb HTTP transport, behind Basic authentication.
// Both the authentication challenge and successful fetch exercise Git itself.
async function withAuthenticatedRemote(
  verify: (fixture: {
    cwd: string;
    run: RunGitCommand;
    root: string;
    origin: string;
    expectedOid: string;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "paseo-fetch-auth-"));
  const cwd = join(root, "checkout");
  const remote = join(root, "remote.git");
  const emptyConfig = join(root, "gitconfig");
  const askpass = join(root, "askpass.sh");
  const marker = join(root, "prompts");
  await writeFile(emptyConfig, "");
  await writeFile(
    askpass,
    `#!/bin/sh\nprintf 'prompt\\n' >> '${marker.replaceAll("'", "'\\''")}'\nexit 1\n`,
  );
  await chmod(askpass, 0o755);
  const askpassCommand = askpass;
  const run: RunGitCommand = (args, options) =>
    runGitCommand(args, {
      ...options,
      env: {
        ...options.env,
        GIT_CONFIG_GLOBAL: emptyConfig,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_ASKPASS: askpassCommand,
        SSH_ASKPASS: askpassCommand,
      },
    });
  const server = createServer(async (request, response) => {
    if (
      request.headers.authorization !== `Basic ${Buffer.from("fixture:secret").toString("base64")}`
    ) {
      response.writeHead(401, { "WWW-Authenticate": 'Basic realm="git-test"' });
      response.end();
      return;
    }
    const pathname = new URL(request.url!, "http://localhost").pathname;
    try {
      const contents = await readFile(join(root, pathname));
      response.writeHead(200, { "Content-Type": "application/octet-stream" });
      response.end(contents);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  try {
    await run(["init", "--initial-branch=main", cwd], { cwd: root });
    await run(
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "initial",
      ],
      { cwd },
    );
    await run(["clone", "--bare", cwd, remote], { cwd: root });
    await run(["update-server-info"], { cwd: remote });
    await run(["config", "credential.helper", ""], { cwd });
    await run(["config", "core.askPass", askpassCommand], { cwd });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP server");
    const origin = `http://127.0.0.1:${address.port}/remote.git`;
    await run(["remote", "add", "origin", origin], { cwd });
    const expectedOid = (await run(["rev-parse", "HEAD"], { cwd })).stdout.trim();
    await verify({ cwd, run, root, origin, expectedOid });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

test.skipIf(process.platform === "win32")(
  "background fetches never invoke askpass when credentials are missing",
  async () => {
    await withAuthenticatedRemote(async ({ cwd, run, root }) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await fetchWorkspaceGitRemote(cwd, { onRefSnapshot() {} }, run);
        expect(String(result.error)).toContain("terminal prompts disabled");
      }
      await expect(readFile(join(root, "prompts"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  },
);

test.skipIf(process.platform === "win32")(
  "background fetches still use stored credentials",
  async () => {
    await withAuthenticatedRemote(async ({ cwd, run, root, origin, expectedOid }) => {
      const credentials = join(root, "credentials");
      await writeFile(credentials, origin.replace("http://", "http://fixture:secret@") + "\n");
      await run(["config", "credential.helper", `store --file="${credentials}"`], { cwd });

      const result = await fetchWorkspaceGitRemote(cwd, { onRefSnapshot() {} }, run);

      expect(result.error).toBeNull();
      expect(result.changes).toContainEqual({
        kind: "added",
        ref: "origin/main",
        afterOid: expectedOid,
      });
      expect((await run(["rev-parse", "refs/remotes/origin/main"], { cwd })).stdout.trim()).toBe(
        expectedOid,
      );
      await expect(readFile(join(root, "prompts"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  },
);
