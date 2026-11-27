import { describe, expect, test } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildBackgroundFetchEnvOverlay,
  diffWorkspaceGitRefs,
  diffWorkspaceGitRemoteRefs,
  fetchWorkspaceGitRemote,
  isGitFetchAuthError,
  parseWorkspaceGitRefs,
} from "./workspace-git-fetch.js";
import { runGitCommand, type RunGitCommand } from "../utils/run-git-command.js";

describe("buildBackgroundFetchEnvOverlay", () => {
  test("disables terminal and GUI prompts while guarding Linux headless D-Bus autolaunch", async () => {
    await expect(
      buildBackgroundFetchEnvOverlay({
        platform: "linux",
        env: {},
        uid: 0,
        socketExists: () => false,
      }),
    ).resolves.toEqual({
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "",
      GCM_INTERACTIVE: "0",
      SSH_ASKPASS: "",
      SSH_ASKPASS_REQUIRE: "never",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/dev/null",
    });

    await expect(
      buildBackgroundFetchEnvOverlay({
        platform: "linux",
        env: { DBUS_SESSION_BUS_ADDRESS: "autolaunch:" },
        uid: 1000,
        socketExists: () => false,
      }),
    ).resolves.toEqual({
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "",
      GCM_INTERACTIVE: "0",
      SSH_ASKPASS: "",
      SSH_ASKPASS_REQUIRE: "never",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/dev/null",
    });
  });

  test("preserves explicit DBUS_SESSION_BUS_ADDRESS and resolves existing runtime bus sockets", async () => {
    await expect(
      buildBackgroundFetchEnvOverlay({
        platform: "linux",
        env: { DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" },
        uid: 1000,
        socketExists: () => false,
      }),
    ).resolves.toEqual({
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "",
      GCM_INTERACTIVE: "0",
      SSH_ASKPASS: "",
      SSH_ASKPASS_REQUIRE: "never",
    });

    await expect(
      buildBackgroundFetchEnvOverlay({
        platform: "linux",
        env: { XDG_RUNTIME_DIR: "/run/user/1000" },
        uid: 1000,
        socketExists: (socketPath) => socketPath === "/run/user/1000/bus",
      }),
    ).resolves.toEqual({
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "",
      GCM_INTERACTIVE: "0",
      SSH_ASKPASS: "",
      SSH_ASKPASS_REQUIRE: "never",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    });

    // Systemd service with unset XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS,
    // but an active logind runtime socket at /run/user/<uid>/bus.
    await expect(
      buildBackgroundFetchEnvOverlay({
        platform: "linux",
        env: {},
        uid: 1000,
        socketExists: (socketPath) => socketPath === "/run/user/1000/bus",
      }),
    ).resolves.toEqual({
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "",
      GCM_INTERACTIVE: "0",
      SSH_ASKPASS: "",
      SSH_ASKPASS_REQUIRE: "never",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    });

    await expect(
      buildBackgroundFetchEnvOverlay({
        platform: "linux",
        env: { DBUS_SESSION_BUS_ADDRESS: "autolaunch:" },
        uid: 1000,
        socketExists: (socketPath) => socketPath === "/run/user/1000/bus",
      }),
    ).resolves.toEqual({
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "",
      GCM_INTERACTIVE: "0",
      SSH_ASKPASS: "",
      SSH_ASKPASS_REQUIRE: "never",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    });
  });

  test("omits DBUS_SESSION_BUS_ADDRESS on non-Linux platforms", async () => {
    for (const platform of ["darwin", "win32"] as const) {
      await expect(
        buildBackgroundFetchEnvOverlay({
          platform,
          env: {},
          uid: null,
          socketExists: () => false,
        }),
      ).resolves.toEqual({
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "",
        GCM_INTERACTIVE: "0",
        SSH_ASKPASS: "",
        SSH_ASKPASS_REQUIRE: "never",
      });
    }
  });
});

describe("workspace Git remote refs", () => {
  test("runs the complete fetch through the supplied Git runner", async () => {
    const commands: string[][] = [];
    let refRead = 0;
    const expectedOverlay = await buildBackgroundFetchEnvOverlay();
    const run: RunGitCommand = async (args, options) => {
      commands.push(args);
      if (args[0] === "fetch") {
        expect(options.envOverlay).toEqual(expectedOverlay);
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
    await run(["--git-dir", remote, "update-server-info"], { cwd: root });
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

test.skipIf(process.platform === "win32")(
  "background fetches pass DBUS_SESSION_BUS_ADDRESS=unix:path=/dev/null to credential helpers on headless Linux",
  async () => {
    for (const initialDbus of [undefined, "autolaunch:", "unix:path=/tmp/live-session-bus"]) {
      await withAuthenticatedRemote(async ({ cwd, run, root }) => {
        const captureFile = join(root, "helper-env.txt");
        const helperScript = join(root, "credential-helper.sh");
        await writeFile(
          helperScript,
          [
            "#!/bin/sh",
            `printf 'DBUS=%s\\nSSH_ASKPASS=%s\\nSSH_ASKPASS_REQUIRE=%s\\nGIT_TERMINAL_PROMPT=%s\\nGIT_ASKPASS=%s\\nGCM_INTERACTIVE=%s\\n' \\`,
            '  "${DBUS_SESSION_BUS_ADDRESS-<unset>}" \\',
            '  "${SSH_ASKPASS-<unset>}" \\',
            '  "${SSH_ASKPASS_REQUIRE-<unset>}" \\',
            '  "${GIT_TERMINAL_PROMPT-<unset>}" \\',
            '  "${GIT_ASKPASS-<unset>}" \\',
            '  "${GCM_INTERACTIVE-<unset>}" \\',
            `  > '${captureFile.replaceAll("'", "'\\''")}'`,
            "exit 1",
            "",
          ].join("\n"),
        );
        await chmod(helperScript, 0o755);
        await run(["config", "credential.helper", helperScript], { cwd });

        const headlessEnv =
          initialDbus === undefined ? {} : { DBUS_SESSION_BUS_ADDRESS: initialDbus };
        const headlessRun: RunGitCommand = (args, options) =>
          run(args, {
            ...options,
            env: {
              ...options.env,
              ...headlessEnv,
            },
          });

        const result = await fetchWorkspaceGitRemote(cwd, { onRefSnapshot() {} }, headlessRun, {
          platform: "linux",
          env: headlessEnv,
          uid: 999_999,
          socketExists: () => false,
        });

        expect(String(result.error)).toContain("terminal prompts disabled");
        const captured = await readFile(captureFile, "utf8");
        const expectedDbus =
          initialDbus === undefined || initialDbus === "autolaunch:"
            ? "unix:path=/dev/null"
            : initialDbus;
        expect(captured).toBe(
          [
            `DBUS=${expectedDbus}`,
            "SSH_ASKPASS=",
            "SSH_ASKPASS_REQUIRE=never",
            "GIT_TERMINAL_PROMPT=0",
            "GIT_ASKPASS=",
            "GCM_INTERACTIVE=0",
            "",
          ].join("\n"),
        );
      });
    }
  },
);

describe("isGitFetchAuthError", () => {
  test.each([
    new Error("fatal: could not read Username for 'https://github.com': terminal prompts disabled"),
    new Error(
      "fatal: could not read Password for 'https://example.com': terminal prompts disabled",
    ),
    new Error("fatal: Authentication failed for 'https://github.com/org/repo.git/'"),
    new Error("remote: Invalid username or token. Password authentication is not supported"),
    new Error(
      "fatal: unable to access 'https://example.com/repo.git/': The requested URL returned error: 401",
    ),
    new Error(
      "fatal: unable to access 'https://example.com/repo.git/': The requested URL returned error: 403",
    ),
    new Error("Logon failed, use ctrl+c to cancel basic credential prompt."),
    new Error(
      "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.",
    ),
    new Error("Host key verification failed.\nfatal: Could not read from remote repository."),
    new Error("Received disconnect from 1.2.3.4 port 22:2: Too many authentication failures"),
  ])("classifies auth/credential failure as auth error: %s", (error) => {
    expect(isGitFetchAuthError(error)).toBe(true);
  });

  test.each([
    new Error("Git command timed out after 120000ms: git fetch origin --prune"),
    new Error(
      "ssh: Could not resolve hostname github.com: Temporary failure in name resolution\nfatal: Could not read from remote repository.",
    ),
    new Error(
      "fatal: unable to access 'https://github.com/org/repo.git/': Failed to connect to github.com port 443: Connection timed out",
    ),
    new Error(
      "fatal: unable to access 'https://github.com/org/repo.git/': The requested URL returned error: 503",
    ),
    new Error(
      "fatal: unable to access 'https://github.com/org/repo.git/': The requested URL returned error: 429",
    ),
    new Error("error: RPC failed; curl 56 Recv failure: Connection reset by peer"),
  ])("classifies network/timeout/server failure as transient: %s", (error) => {
    expect(isGitFetchAuthError(error)).toBe(false);
  });
});
