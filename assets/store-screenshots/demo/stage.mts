// Stages the demo host used for store screenshots.
//
//   npx tsx assets/store-screenshots/demo/stage.mts
//
// Starts an in-process daemon on DEMO_PORT (default 7791) with scripted Claude
// Code and Codex clients, adds a local clone of this repository as the `paseo`
// project, cuts real worktrees, applies a real change to the hero worktree, and
// opens a terminal there. Leave it running while you capture.
import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTestPaseoDaemon } from "../../../packages/server/src/server/test-utils/paseo-daemon.js";
import { DaemonClient } from "../../../packages/server/src/server/test-utils/daemon-client.js";
import { type AgentScript, ScriptedAgentClient } from "./scripted-agents.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const demoRoot = path.join(repoRoot, ".dev/store-capture/demo");
const codeRoot = path.join(demoRoot, "code");
const pluginDir = path.join(here, "preview-deploys");
const port = Number(process.env.DEMO_PORT ?? 7791);
const minute = 60_000;

const claudeScripts: AgentScript[] = [];
const codexScripts: AgentScript[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Mo", "-c", "user.email=mo@paseo.sh", ...args], {
    cwd,
    encoding: "utf8",
  });
}

function run(cwd: string, command: string): string {
  return execSync(command, { cwd, encoding: "utf8", env: { ...process.env, FORCE_COLOR: "0" } });
}

async function prepareRepos(): Promise<void> {
  // A fresh clone each run: worktrees from an earlier run stay registered in it.
  // Worktree setup (npm ci, builds) is dropped so new worktrees open instantly.
  const paseo = path.join(codeRoot, "paseo");
  await rm(paseo, { recursive: true, force: true });
  await mkdir(codeRoot, { recursive: true });
  execFileSync("git", ["clone", "-q", "--local", repoRoot, paseo]);
  git(paseo, "checkout", "-q", "-B", "main");
  git(paseo, "remote", "remove", "origin");
  const config = JSON.parse(await readFile(path.join(paseo, "paseo.json"), "utf8"));
  delete config.worktree;
  await writeFile(path.join(paseo, "paseo.json"), `${JSON.stringify(config, null, 2)}\n`);
  git(paseo, "commit", "-qam", "chore: skip worktree setup in demo");
  const dotfiles = path.join(codeRoot, "dotfiles");
  if (!existsSync(dotfiles)) {
    await mkdir(dotfiles, { recursive: true });
    await writeFile(path.join(dotfiles, "tmux.conf"), "set -g mouse on\nset -g base-index 1\n");
    await writeFile(path.join(dotfiles, "zshrc"), "export EDITOR=nvim\nalias g=git\n");
    git(dotfiles, "init", "-q", "-b", "main");
    git(dotfiles, "add", ".");
    git(dotfiles, "commit", "-qm", "Initial dotfiles");
  }
}

async function main(): Promise<void> {
  await prepareRepos();
  const home = path.join(demoRoot, "home");
  await rm(home, { recursive: true, force: true });
  await mkdir(home, { recursive: true });

  const daemon = await createTestPaseoDaemon({
    agentClients: {
      claude: new ScriptedAgentClient("claude", claudeScripts),
      codex: new ScriptedAgentClient("codex", codexScripts),
    },
    listen: "127.0.0.1",
    listenPort: port,
    paseoHomeRoot: home,
    mcpEnabled: false,
    cleanup: false,
    pluginsEnabled: true,
    plugins: {
      "preview-deploys": { source: "directory", path: pluginDir, enabled: true },
    },
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.14.0",
  });
  await client.connect();
  await client.fetchAgents({ subscribe: {} });

  const paseo = await client.addProject(path.join(codeRoot, "paseo"));
  const dotfiles = await client.addProject(path.join(codeRoot, "dotfiles"));
  const paseoProjectId = paseo.project!.projectId;

  async function worktree(title: string, branchName: string) {
    const result = await client.createWorkspace({
      title,
      source: {
        kind: "worktree",
        projectId: paseoProjectId,
        action: "branch-off",
        baseBranch: "main",
        branchName,
      },
    });
    if (!result.workspace) throw new Error(`No workspace for ${title}: ${JSON.stringify(result)}`);
    return result.workspace;
  }

  async function agent(input: {
    provider: "claude" | "codex";
    workspace: { id: string; workspaceDirectory?: string | null };
    cwd: string;
    title: string;
    script: AgentScript;
  }) {
    (input.provider === "claude" ? claudeScripts : codexScripts).push(input.script);
    return client.createAgent({
      provider: input.provider,
      cwd: input.cwd,
      workspaceId: input.workspace.id,
      title: input.title,
      initialPrompt: input.script.prompt,
    });
  }

  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  // Done: finished earlier and already read.
  const release = await worktree("Release v0.14.0-beta.1", "release/0.14.0-beta.1");
  const releaseAgent = await agent({
    provider: "codex",
    workspace: release,
    cwd: release.workspaceDirectory!,
    title: "Release v0.14.0-beta.1",
    script: {
      prompt: "Cut 0.14.0-beta.1 from main and draft the release notes.",
      steps: [
        {
          kind: "tool",
          name: "shell",
          detail: {
            type: "shell",
            command: "npm run release:beta",
            output: "Tagged v0.14.0-beta.1\n",
            exitCode: 0,
          },
        },
        {
          kind: "say",
          text: "Tagged `v0.14.0-beta.1` and drafted the release notes. CI is building the desktop and mobile artifacts.",
        },
      ],
    },
  });
  const dotfilesWorkspace = (
    await client.createWorkspace({
      title: "Add a tmux status line",
      source: {
        kind: "directory",
        path: path.join(codeRoot, "dotfiles"),
        projectId: dotfiles.project!.projectId,
      },
    })
  ).workspace!;
  const tmuxAgent = await agent({
    provider: "claude",
    workspace: dotfilesWorkspace,
    cwd: path.join(codeRoot, "dotfiles"),
    title: "Add a tmux status line",
    script: {
      prompt: "Add a minimal tmux status line with the session name and battery.",
      steps: [
        {
          kind: "tool",
          name: "Edit",
          detail: {
            type: "edit",
            filePath: "tmux.conf",
            oldString: "",
            newString: "set -g status-right '#S · #{battery_percentage}'",
          },
        },
        {
          kind: "say",
          text: "Added a status line with the session name on the left and battery on the right.",
        },
      ],
    },
  });
  await pause(3000);
  await client.clearAgentAttention([releaseAgent.id, tmuxAgent.id]);

  // Working: turns that stay open while you capture.
  const ipad = await worktree(
    "Keep the composer above the iPad keyboard",
    "fix/ipad-keyboard-inset",
  );
  await agent({
    provider: "codex",
    workspace: ipad,
    cwd: ipad.workspaceDirectory!,
    title: "Keep the composer above the iPad keyboard",
    script: {
      prompt:
        "On iPad with a hardware keyboard attached, the composer jumps up as if the software keyboard were open. Find out why and fix it.",
      keepRunning: true,
      steps: [
        {
          kind: "tool",
          name: "shell",
          detail: {
            type: "shell",
            command: 'rg -n "keyboardHeight" packages/app/src',
            output:
              "packages/app/src/keyboard/shift/internal/provider.ts:41:  const keyboardHeight = useSharedValue(0);\n",
            exitCode: 0,
          },
        },
        {
          kind: "tool",
          name: "read",
          detail: {
            type: "read",
            filePath: "packages/app/src/keyboard/shift/internal/provider.ts",
          },
        },
        {
          kind: "say",
          text: "The shift provider trusts the keyboard frame event. With a hardware keyboard, iPadOS still reports the shortcuts bar as a keyboard frame, so we lift the composer by its full height. Checking the frame against the screen bottom next.",
        },
        {
          kind: "running-tool",
          name: "shell",
          detail: { type: "shell", command: "npx vitest run packages/app/src/keyboard" },
        },
      ],
    },
  });
  const snapshots = await worktree(
    "Cache provider snapshots on disk",
    "perf/provider-snapshot-cache",
  );
  await agent({
    provider: "claude",
    workspace: snapshots,
    cwd: snapshots.workspaceDirectory!,
    title: "Cache provider snapshots on disk",
    script: {
      prompt:
        "Cold start spends about two seconds probing providers. Cache the last provider snapshot on disk and refresh it in the background.",
      keepRunning: true,
      steps: [
        {
          kind: "todo",
          items: [
            { text: "Find where snapshots are built", completed: true },
            { text: "Persist the last snapshot per host", completed: false },
            { text: "Refresh in the background after boot", completed: false },
          ],
        },
        {
          kind: "tool",
          name: "Read",
          detail: {
            type: "read",
            filePath: "packages/server/src/server/agent/provider-snapshot-manager.ts",
          },
        },
        {
          kind: "running-tool",
          name: "Edit",
          detail: {
            type: "edit",
            filePath: "packages/server/src/server/agent/provider-snapshot-manager.ts",
          },
        },
      ],
    },
  });

  // Needs input: waiting on a permission.
  const korean = await worktree("Korean translations for Settings", "i18n/ko-settings");
  await agent({
    provider: "claude",
    workspace: korean,
    cwd: korean.workspaceDirectory!,
    title: "Korean translations for Settings",
    script: {
      prompt: "Translate the new Settings strings into Korean and open a PR.",
      steps: [
        {
          kind: "tool",
          name: "Read",
          detail: { type: "read", filePath: "packages/app/src/i18n/resources/en.ts" },
        },
        {
          kind: "tool",
          name: "Edit",
          detail: { type: "edit", filePath: "packages/app/src/i18n/resources/ko.ts" },
        },
        {
          kind: "tool",
          name: "Bash",
          detail: {
            type: "shell",
            command: "npm run test --workspace=@getpaseo/app -- i18n",
            output: "Test Files  3 passed (3)\n     Tests  41 passed (41)\n",
            exitCode: 0,
          },
        },
        { kind: "say", text: "Translated 18 strings. I'll push the branch so I can open the PR." },
        {
          kind: "ask",
          name: "Bash",
          title: "Bash",
          detail: { type: "shell", command: "git push -u origin i18n/ko-settings" },
        },
      ],
    },
  });

  // Ready to review: a second finished agent.
  const terminals = await worktree(
    "Remember the last terminal per workspace",
    "feat/remember-terminal",
  );
  await agent({
    provider: "codex",
    workspace: terminals,
    cwd: terminals.workspaceDirectory!,
    title: "Remember the last terminal per workspace",
    script: {
      prompt:
        "When I switch back to a workspace, open the terminal I was using last instead of the first one.",
      steps: [
        {
          kind: "tool",
          name: "shell",
          detail: {
            type: "shell",
            command: 'rg -n "activeTerminalId" packages/app/src',
            output: "",
            exitCode: 0,
          },
        },
        {
          kind: "say",
          text: "Workspaces now remember their last focused terminal and reopen it when you switch back. The choice is stored per host, so it survives restarts.",
        },
      ],
    },
  });

  // Plugin: the agent "built" the preview-deploys plugin this daemon runs.
  const plugin = await worktree("Build a preview deploys plugin", "plugins/preview-deploys");
  const pluginSource = (file: string) => run(pluginDir, `cat ${file}`);
  await agent({
    provider: "claude",
    workspace: plugin,
    cwd: plugin.workspaceDirectory!,
    title: "Build a preview deploys plugin",
    script: {
      prompt: "Build me a plugin that shows our preview deploys right next to the composer.",
      stepDelayMs: 6_000,
      steps: [
        { kind: "tool", name: "Read", detail: { type: "read", filePath: "docs/plugins.md" } },
        {
          kind: "tool",
          name: "Write",
          detail: {
            type: "write",
            filePath: "plugins/preview-deploys/paseo-plugin.json",
            content: pluginSource("paseo-plugin.json"),
          },
        },
        {
          kind: "tool",
          name: "Write",
          detail: {
            type: "write",
            filePath: "plugins/preview-deploys/index.client.tsx",
            content: pluginSource("index.client.tsx"),
          },
        },
        {
          kind: "tool",
          name: "Bash",
          detail: {
            type: "shell",
            command: "paseo plugin install ./plugins/preview-deploys",
            output: "Installed preview-deploys\n",
            exitCode: 0,
          },
        },
        {
          kind: "say",
          text: "Done. **Deploys** now sits above the composer in every workspace. Tap it to see production and the latest preview for each branch, with build progress and failures.",
        },
      ],
    },
  });

  // Hero: Claude finished a real change in a real worktree.
  const jitter = await worktree("Add jitter to reconnect backoff", "fix/reconnect-jitter");
  const cwd = jitter.workspaceDirectory!;
  await symlink(path.join(repoRoot, "node_modules"), path.join(cwd, "node_modules"));
  execFileSync("node", [path.join(here, "change/apply.mjs"), cwd]);
  const clientDiff = git(cwd, "diff", "--", "packages/client/src/daemon-client.ts");
  const vitest = run(
    cwd,
    "npx vitest run packages/client/src/connection/reconnect-delay.test.ts",
  ).replace(/^ RUN .*\n/m, "");
  const readExcerpt = run(cwd, "sed -n '7067,7086p' packages/client/src/daemon-client.ts");
  await agent({
    provider: "claude",
    workspace: jitter,
    cwd,
    title: "Add jitter to reconnect backoff",
    script: {
      prompt:
        'When the relay restarts, every phone reconnects at the same moment and we get a spike. Add jitter to the reconnect backoff, keep the 30s cap, and make sure the "Retrying in" countdown still matches the real delay.',
      stepDelayMs: 7_000,
      steps: [
        {
          kind: "tool",
          name: "Grep",
          detail: {
            type: "search",
            toolName: "grep",
            query: "reconnectAttempt",
            filePaths: ["packages/client/src/daemon-client.ts"],
            numFiles: 1,
            numMatches: 9,
            mode: "files_with_matches",
          },
        },
        {
          kind: "tool",
          name: "Read",
          detail: {
            type: "read",
            filePath: "packages/client/src/daemon-client.ts",
            offset: 7040,
            limit: 60,
            content: readExcerpt,
          },
        },
        {
          kind: "say",
          text: "The delay is calculated twice: once for `nextRetryAt`, which drives the countdown, and again when the timer is armed. Both use plain doubling, so every client retries on the same schedule. If I add randomness in both places the countdown will be wrong, so I'll draw the jitter once per attempt and share it.",
        },
        {
          kind: "tool",
          name: "Write",
          detail: {
            type: "write",
            filePath: "packages/client/src/connection/reconnect-delay.ts",
            content: run(cwd, "cat packages/client/src/connection/reconnect-delay.ts"),
          },
        },
        {
          kind: "tool",
          name: "Edit",
          detail: {
            type: "edit",
            filePath: "packages/client/src/daemon-client.ts",
            unifiedDiff: clientDiff,
          },
        },
        {
          kind: "tool",
          name: "Write",
          detail: {
            type: "write",
            filePath: "packages/client/src/connection/reconnect-delay.test.ts",
            content: run(cwd, "cat packages/client/src/connection/reconnect-delay.test.ts"),
          },
        },
        {
          kind: "tool",
          name: "Bash",
          detail: {
            type: "shell",
            command: "npx vitest run packages/client/src/connection/reconnect-delay.test.ts",
            output: vitest,
            exitCode: 0,
          },
        },
        {
          kind: "tool",
          name: "Edit",
          detail: {
            type: "edit",
            filePath: "CHANGELOG.md",
            unifiedDiff: git(cwd, "diff", "--", "CHANGELOG.md"),
          },
        },
        {
          kind: "say",
          text: [
            "Reconnects now back off with jitter.",
            "",
            "- `getReconnectDelayMs` picks a delay between half and the full backoff, still capped at 30s.",
            '- `DaemonClient` draws the delay once per attempt, so the "Retrying in" countdown matches the actual retry.',
            "- Four new tests cover the doubling, the cap, the jitter range, and a quick first retry.",
            "",
            "Tests pass. After a relay restart, clients now spread their reconnects across the backoff window instead of arriving together.",
          ].join("\n"),
        },
      ],
    },
  });

  const terminal = await client.createTerminal(cwd, "zsh", undefined, {
    workspaceId: jitter.id,
    command: "bash",
    args: ["--rcfile", path.join(here, "terminal-rc.sh"), "-i"],
  });
  const terminalId = terminal.terminal?.id;
  if (terminalId) {
    await pause(1500);
    for (const line of [
      "git status --short",
      "cd packages/client",
      "npx vitest run reconnect --reporter=tree",
    ]) {
      client.sendTerminalInput(terminalId, { type: "input", data: `${line}\r` });
      await pause(4000);
    }
  }

  console.log(`READY port=${daemon.port} home=${daemon.paseoHome}`);
  await writeFile(
    path.join(demoRoot, "state.json"),
    JSON.stringify(
      { port: daemon.port, home: daemon.paseoHome, hero: { workspaceId: jitter.id, cwd } },
      null,
      2,
    ),
  );
  const stop = async () => {
    await client.close();
    await daemon.close();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  void minute;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
