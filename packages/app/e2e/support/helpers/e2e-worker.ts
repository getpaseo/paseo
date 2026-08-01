import { execSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { forkPaseoHomeMetadata, resolvePaseoHomePath } from "./paseo-home-fork";
import { startIsolatedHostDaemon } from "./isolated-host-daemon";

export interface E2EWorker {
  close(): Promise<void>;
}

function resolveOptionalHome(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return resolvePaseoHomePath(trimmed === "current" ? "~/.paseo" : trimmed);
}

async function createFakeEditorBin(): Promise<string> {
  const binDir = await mkdtemp(path.join(tmpdir(), "paseo-e2e-editor-bin-"));
  let realGhPath = "";
  try {
    realGhPath = execSync("which gh").toString().trim();
  } catch {
    // The local GitHub fixture remains usable without a system gh binary.
  }

  const fakeEditorSource = `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const recordPath = process.env.PASEO_E2E_EDITOR_RECORD_PATH;
if (recordPath) {
  fs.appendFileSync(recordPath, JSON.stringify({
    command: path.basename(process.argv[1]),
    args: process.argv.slice(2),
    cwd: process.cwd(),
    at: Date.now()
  }) + "\\n");
}
`;
  for (const editorCommand of ["cursor", "code"]) {
    const editorPath = path.join(binDir, editorCommand);
    await writeFile(editorPath, fakeEditorSource);
    await chmod(editorPath, 0o755);
  }

  const fakeGhPath = path.join(binDir, "gh");
  const fakeGhSource = `#!/usr/bin/env node
const { spawnSync } = require("child_process");
const args = process.argv.slice(2);
const fixtureRemote = "https://github.com/paseo-e2e/local-fixture.git";
const origin = spawnSync("git", ["config", "--get", "remote.origin.url"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"]
}).stdout?.trim();

if (origin === fixtureRemote) {
  const command = args.slice(0, 2).join(" ");
  if (command === "auth status") process.exit(0);
  if (command === "repo view") {
    process.stdout.write(JSON.stringify({ owner: { login: "paseo-e2e" }, name: "local-fixture", parent: null }));
    process.exit(0);
  }
  if (command === "issue list") {
    process.stdout.write("[]");
    process.exit(0);
  }
  if (command === "pr list" || command === "pr view") {
    const pr = {
      number: 1,
      title: "Use pasted PR as start ref",
      url: "https://github.com/paseo-e2e/local-fixture/pull/1",
      state: "OPEN",
      body: null,
      labels: [],
      baseRefName: "main",
      headRefName: "pr-branch-1",
      updatedAt: "2026-01-01T00:00:00Z"
    };
    process.stdout.write(JSON.stringify(command === "pr list" ? [pr] : pr));
    process.exit(0);
  }
  if (command === "api graphql" && args.some((arg) => arg.includes("PullRequestCheckoutTarget"))) {
    process.stdout.write(JSON.stringify({
      data: { repository: { pullRequest: {
        number: 1,
        baseRefName: "main",
        headRefName: "pr-branch-1",
        isCrossRepository: false,
        headRepositoryOwner: { login: "paseo-e2e" },
        headRepository: {
          sshUrl: "git@github.com:paseo-e2e/local-fixture.git",
          url: fixtureRemote
        }
      } } }
    }));
    process.exit(0);
  }
  process.stderr.write("Unsupported local GitHub fixture command: " + args.join(" ") + "\\n");
  process.exit(1);
}

const realGhPath = ${JSON.stringify(realGhPath)};
if (!realGhPath) process.exit(127);
const result = spawnSync(realGhPath, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`;
  await writeFile(fakeGhPath, fakeGhSource);
  await chmod(fakeGhPath, 0o755);
  return binDir;
}

async function applyMetadataFork(targetHome: string): Promise<void> {
  const sourceHome = resolveOptionalHome(process.env.E2E_FORK_PASEO_HOME_FROM);
  if (!sourceHome) return;
  const result = await forkPaseoHomeMetadata({ sourceHome, targetHome });
  process.env.E2E_FORK_SOURCE_PASEO_HOME = result.sourceHome;
  process.env.E2E_FORK_TARGET_PASEO_HOME = result.targetHome;
  process.env.E2E_FORK_COPIED_FILES = String(result.copiedFiles);
  process.env.E2E_FORK_COPIED_BYTES = String(result.copiedBytes);
}

export async function startE2EWorker(workerIndex: number): Promise<E2EWorker> {
  const requestedRoot = resolveOptionalHome(process.env.E2E_PASEO_HOME);
  const paseoHome = requestedRoot
    ? path.join(requestedRoot, `worker-${workerIndex}`)
    : await mkdtemp(path.join(tmpdir(), `paseo-e2e-worker-${workerIndex}-`));
  const preserveHome = Boolean(requestedRoot) || process.env.E2E_KEEP_PASEO_HOME === "1";
  const fakeEditorBin = await createFakeEditorBin();
  const editorRecordPath = path.join(paseoHome, "editor-open-records.jsonl");
  const serverId = `srv_e2e_worker_${workerIndex}`;

  try {
    await applyMetadataFork(paseoHome);
    const daemon = await startIsolatedHostDaemon(serverId, {
      paseoHome,
      preserveHome,
      environment: {
        NODE_ENV: "development",
        PATH: `${fakeEditorBin}${path.delimiter}${process.env.PATH ?? ""}`,
        PASEO_E2E_EDITOR_RECORD_PATH: editorRecordPath,
      },
    });

    process.env.E2E_DAEMON_PORT = String(daemon.port);
    process.env.E2E_SERVER_ID = daemon.serverId;
    process.env.E2E_PASEO_HOME = daemon.paseoHome;
    process.env.E2E_EDITOR_RECORD_PATH = editorRecordPath;
    delete process.env.E2E_RELAY_PORT;
    delete process.env.E2E_RELAY_DAEMON_PUBLIC_KEY;

    console.log(
      `[e2e] Worker ${workerIndex} daemon started on port ${daemon.port}, home: ${daemon.paseoHome}`,
    );
    return {
      close: async () => {
        await daemon.close();
        await rm(fakeEditorBin, { recursive: true, force: true });
        console.log(`[e2e] Worker ${workerIndex} daemon stopped`);
      },
    };
  } catch (error) {
    await rm(fakeEditorBin, { recursive: true, force: true });
    if (!preserveHome) await rm(paseoHome, { recursive: true, force: true });
    throw error;
  }
}
