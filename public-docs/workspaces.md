---
title: Workspaces
description: Understand how Paseo groups working directories, agents, terminals, and browsers into workspaces.
nav: Workspaces
order: 10
category: Workspaces
---

# Workspaces

Paseo is organized around workspaces, not chats.

A workspace is the place where a task happens. It has a working directory and can contain multiple sessions running at the same time. In the app, each session opens as a tab.

## Projects contain workspaces

The sidebar starts with projects. A project can be a git repository, a GitHub project, or any directory on a machine running the Paseo daemon.

Inside each project are workspaces. For example:

```
my-app
├── main
├── fix-login-flow
└── redesign-settings
```

Each workspace is a separate place to work. You can keep one for your main checkout, create another for a feature, or open a GitHub PR as another workspace.

Use the [CLI project commands](/docs/cli#projects) to register, list, rename, or delete projects.

## Workspaces contain sessions

Agents run inside a workspace as sessions. A workspace can have one agent session, several agent sessions, terminals, browsers, and diffs open at the same time.

That matters because real development rarely fits into one long chat. You might ask one agent to implement a feature, open a terminal to run a service, start another agent to review the diff, and keep the browser open next to both. Those belong together because they are all part of the same task.

In Paseo, the workspace is the stable container. The sessions are what you run inside it.

## Choose the isolation

When you create a workspace, **Isolation** sets the directory it works in:

- **Project directory** uses the project's own directory, such as your main checkout. Use it when sessions should share the files already on disk.
- **New worktree** creates a git worktree with its own directory and branch. Use it when a task needs its own copy of the files.
- **Existing worktree** uses a git worktree that is already on disk, on the branch it has checked out. Use it to continue work on a branch without a second copy. The list shows every git worktree of the repository, including the ones that Paseo did not create.

The workspace is the product concept; a git worktree is one way to isolate its files. More than one workspace can use the same worktree. Paseo removes a worktree that it created after the last workspace that uses it is archived. Paseo does not remove a worktree that it did not create.

## Creating a workspace

For a desktop walkthrough from starting parallel agents to reviewing and testing their changes, see [Run parallel tasks](/docs/parallel-development).

You can create a workspace in the app or from the CLI:

```bash
paseo workspace create --isolation local --path ~/dev/my-app --title main
paseo workspace create --isolation worktree --path ~/dev/my-app --base origin/main
```

You can also create a workspace without starting an agent right away. The workspace is still there with its working directory ready; you can open terminals, run services, or browse files, then start an agent later.

Either way, once the workspace exists you can add more sessions to it. Open a terminal alongside an agent, start a second agent to review changes, or open a browser tab to check a local service. Every session lives as a tab inside the same workspace.

Creating an agent and creating a workspace are separate actions. Pass a workspace ID when you want an agent in a specific existing workspace. A bare `paseo run` from a human shell creates a new local workspace; when one agent runs it, Paseo recognizes the caller and creates a subagent in the caller's workspace.

## Worktrees

Every workspace in Paseo is backed by a working directory. When that directory is a git worktree, you get a separate branch and isolated environment for each task.

If you want the details on configuring setup hooks, scripts, and services, continue to [Git worktrees](/docs/worktrees).
