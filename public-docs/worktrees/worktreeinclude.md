---
title: .worktreeinclude
description: Copy gitignored local files into new Paseo worktrees.
nav: .worktreeinclude
order: 12
category: Workspaces
---

# .worktreeinclude

Add `.worktreeinclude` at the root of your source checkout to copy local configuration into new [Git worktrees](/docs/worktrees). Paseo copies matching gitignored files before setup, terminals, and the first Agent start.

## Copy your local configuration

For a project whose `.gitignore` includes `.env` and `config/*.local.json`, create this `.worktreeinclude`:

```gitignore
.env
config/*.local.json
```

When you create a worktree through Paseo, an existing `.env` and matching files such as `config/dev.local.json` are copied to the same relative paths in the new worktree. Their contents stay out of Git.

Commit `.worktreeinclude` to share the patterns with your team. Each teammate supplies their own ignored files in the checkout they create worktrees from.

## Pattern syntax

Use gitignore syntax, with one pattern per line. Comments start with `#`. Prefix a pattern with `!` to exclude a match:

```gitignore
# Local environment and configuration
.env
config/*.local.json
!config/production.local.json
```

A pattern only selects files that Git already ignores. Adding a path here does not ignore it, so also configure `.gitignore` when needed. Tracked files and untracked files that Git does not ignore are excluded.

Paseo does not search inside a directory that Git ignores as a whole, such as `node_modules/`, unless a pattern names that directory or a path inside it. A bare name like `.env` matches `.env` and `apps/web/.env`, but not `node_modules/pkg/.env`. To copy from inside an ignored directory, name it in the pattern, as in `node_modules/pkg/.env` or `.secrets/`. A pattern with a glob in its first directory name, such as `**/.env` or `*/.env`, searches every ignored directory, including `node_modules/`, so name the directory instead when it is large.

## When files are copied

The built-in `worktree-include` plugin reads the file from the checkout you create the worktree from. That source can itself be another worktree. Keep the plugin enabled for copying to run.

- Without `.worktreeinclude`, the plugin copies nothing.
- Matching files must exist in the source checkout.
- Existing destination files are skipped, preserving their contents.
- Copies happen during creation, with no ongoing synchronization between checkouts.
- A copy error aborts creation and removes the new worktree. Avoid including symlinked directories or nested repositories, which cannot be copied as files.

## Run commands during setup

Use `.worktreeinclude` for files that already exist locally. Use a [setup hook](/docs/worktrees#setup-and-teardown) to install dependencies, generate files, or fetch secrets:

```json
{
  "worktree": {
    "setup": "npm ci"
  }
}
```

Put this configuration in `paseo.json` on the base branch used for the new worktree. Copied files are available when setup runs.
