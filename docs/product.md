# Product

What Paseo is, who it's for, and where it's going.

## What is Paseo

Paseo is a next-generation development environment built around agents. One interface to run, monitor, and interact with coding agents across desktop, mobile, terminal, and web.

The development workflow is shifting from manually editing files to orchestrating agents that do the editing. Paseo is built for that workflow.

## Core philosophy

Freedom and flexibility. Every design decision follows from this:

- **Multi-provider** — Use any coding agent harness. Pick the right model for each job, switch freely as the landscape shifts. No vendor lock-in.
- **Cross-device** — Desktop, mobile, web, CLI. Start work at your desk, check progress from your phone, script from the terminal.
- **Self-hosted** — The daemon runs on your machine. Your code, your keys, your environment. No inference markup, no cloud dependency.
- **Respectful** - No telemetry, no forced cloud, no forced accounts
- **Open source** — Apache-2.0. Users can inspect, fork, and contribute.
- **BYOK** — Bring your own keys. Use your subsidized plans and first-party provider pricing. Paseo adds zero cost on top.

## How it works

### Projects and workspaces

Projects are grouped in the sidebar, detected automatically from your filesystem and tagged by git remote when available.

Each project opens as a workspace. For git projects, the default workspace is the main checkout. Users can create additional workspaces, which are isolated copies (git worktrees) where agents work without affecting main.

### Inside a workspace

A workspace is a flexible canvas:

- Launch multiple agents side by side in split panes
- Open terminals alongside agents
- Mix and match providers within the same workspace

### The daemon

Paseo is a client-server system. The daemon (Node.js) runs on your machine, manages agent processes, and streams output in real time over WebSocket. Clients connect to the daemon — locally or remotely.

This architecture means:

- The daemon can run on any machine: laptop, VM, remote server
- Multiple clients can connect simultaneously
- Agents keep running when a client disconnects — the daemon owns them, not the client
- Quitting the desktop app stops the daemon it started, so "restart the app" is a real fix; a daemon you run yourself is unaffected

## Target user

Anyone who builds software:

- Care about owning their tools and their data
- Use multiple AI providers and want to switch freely
- Run agents on real tasks across real projects
- Want to work from multiple devices

## What compounds over time

- **Trust** — Showing up daily, shipping in public, being open source. Earned slowly, lost quickly.
- **Community contributions** — Code, packaging, skills, agent configs. Contributors become advocates.
- **Ecosystem** — Skills, integrations, shared configs. Community-built content that makes the platform more valuable.

## Strategic bets

1. **Models commoditize.** Value moves to the orchestration layer. The best model changes monthly — the workflow layer stays.
2. **Multi-provider wins.** No single provider stays on top. Developers want the best model for each task.
3. **The daemon as infrastructure.** Server/client architecture enables deployment anywhere.
4. **Open source outlasts funding.** Open source communities are resilient. Contributors become advocates.

## Proposed: Local files for worktrees

Status: design agreed; implementation and validation are outstanding.

A remote project may be missing ignored files such as `.env.local` that exist only
on your laptop. Add **Local files** to Project Settings so you can import them
without installing a local daemon or making Paseo a secrets vault.

### Import flow

1. Open Local files on the destination host. Keep its name and exact project path
   visible throughout the flow.
2. Choose files from this device or another connected host and project. Project
   grouping can suggest sources; it never authorizes a transfer.
3. Review filenames, sizes, destination status, and the selected total. Preselect
   small new files. Leave existing files unchecked and label selection as
   replacement. Show unsupported and oversized files with a reason.
4. Optionally select **Include in future worktrees**. Preview the file-list change
   to `paseo.json` before importing. Keep this separate from updating existing files.
5. Select **Import files**. Report each result and let you retry failed transfers
   without repeating successful ones. If files arrive but the configuration write
   fails, report those outcomes separately and provide configuration-only recovery.

Use explicit regular-file paths for the first version. Proposed limits are
10 MiB per file, 25 MiB per import, and 100 files; preselection stays within
1 MiB per file and 10 MiB total. Directory transfer and automatic synchronization
are deferred. During workspace creation, surface missing configured files with
**Import files** and **Continue without files**; heuristic guesses must not block
creation.

### Ownership and behavior

Repository configuration records the paths to include. File contents belong to
each host's project root, identified by its host and project IDs. The client
coordinates transfers and keeps file contents transient. Different hosts can
intentionally use different credentials for the same repository.

Import opaque bytes without parsing or displaying values. Require Git-ignored,
untracked destinations; reject symlinks and paths outside the selected project.
Use protected connections, bounded transfers, restrictive destination permissions,
atomic file publication, and revision checks before replacement. File contents
must stay out of client caches, logs, telemetry, and transcripts. Explain that
agents and scripts on the destination host can read imported files.

New worktrees receive configured files through the existing setup trust gate,
before setup commands run. Preserve files already present in a worktree.
Inclusion must work for projects rooted in repository subdirectories and must
not bypass the trust gate for external contributions.

Updates are manual initially. A later one-way update feature needs an explicit
source, revision-based conflict detection, and truthful source-availability
status. Linking projects must never imply sharing credentials.

### Before release

Implement the capability-gated UI and daemon operations, then verify device and
host imports, interrupted transfers, concurrent writes, source changes, path
containment, configuration-only recovery, and worktree setup. Add focused tests
and browser/mobile QA evidence. Update the worktree guide and security model
before advertising the feature.

## Current state (May 2026)

- Desktop (Electron), mobile (iOS/Android), web, CLI
- Built-in providers: Claude Code (Agent SDK), Codex (app-server), GitHub Copilot (ACP), OpenCode, Pi, OMP
- One-click ACP provider catalog: CodeWhale, Cursor, Hermes, Qwen Coder, Kimi Code, and others — plus custom ACP providers
- Voice mode: dictate prompts or talk through problems hands-free
- MCP server exposes the daemon to other agents (workspaces, create/detach agent, schedules, heartbeats, terminals, workspace renaming)
- Scheduled agents (cron-style triggers) via app, CLI, and MCP
- Frequent releases (multiple per week)
- Community contributions across packaging, providers, and bug fixes
- Key UX: split panes, keybinding customization, workspace model, in-app browser
