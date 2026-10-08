---
title: Run parallel tasks
description: Run coding agents in separate worktrees, review their diffs, and test each change with terminals and the built-in browser in Paseo.
nav: Run parallel tasks
order: 12
category: Workspaces
---

# Run parallel tasks

Use Paseo's desktop app to give several coding agents independent tasks, review their changes, and run the results. Each task gets a workspace with its own git worktree and branch, with agents, files, diffs, terminals, and browser tabs together.

Start with the [desktop app](/docs#desktop-app-recommended), a local git repository, and at least one [coding agent installed and authenticated](/docs/supported-providers). The examples below use a repository with an `origin/main` branch.

## Start two tasks

1. Open **New workspace** and select your project.
2. Set **Isolation** to **New worktree** and choose `origin/main` as the starting ref.
3. Choose an agent and model, then submit a task, for example: “Add filtering to the project list. Run the relevant tests.”
4. Create a second workspace with **New worktree** from the same starting ref. Give its agent another task: “Add keyboard navigation to the settings page. Run the relevant tests.”

Both agents run concurrently. Select either workspace in the sidebar to read progress or send a follow-up. Choose the same provider for both tasks or a different provider for each.

Separate worktrees keep their file edits on separate branches. For two alternative implementations of the same feature, give both agents the same task and compare their results before choosing one.

## Review each change

Select a workspace and open **Changes** from the Command Center to inspect its diff. Open **Files** to browse and edit the source. Use split panes to keep the agent conversation beside the code you're reviewing.

Send corrections to that workspace's agent. To get another opinion, use **New agent** in the same workspace and ask it to review the changes without editing files. Agents in the same workspace share its working directory.

## Run and test the app

In the selected workspace, use **New terminal** from the Command Center. Install dependencies and run your project's test or development command there.

Each worktree has its own files, but processes still share the machine's network ports. Assign a different dev-server port to each running copy. For repeatable setup and service ports, configure [worktree setup and scripts](/docs/worktrees#paseojson).

For a web app, use **New browser** and enter that workspace's dev-server URL. Exercise the changed flow, then switch workspaces to test the other implementation. Browser tabs run inside the desktop app.

You can also ask the agent to check the app in those tabs. Enable [browser automation](/docs/browser#enabling), then give it the URL and concrete steps to verify, for example:

> Open http://localhost:3001, filter the project list by name, and verify that clearing the filter restores the full list. Report any failures and take a screenshot of the result.

## Choose what to merge

Review the diff and test results for each workspace. Ask for any remaining changes before committing and opening a pull request for that branch, using your usual Git workflow in the workspace terminal or through its agent.

For independent tasks, review and merge each branch. For competing implementations, choose the version you want to keep. Archive a workspace when you no longer need it; [worktree cleanup](/docs/worktrees#manage-the-workspace) removes the managed directory after its last workspace is archived.

## Let an agent coordinate the tasks

When you want an agent to create the workspaces, launch workers, and collect their results, use [orchestration](/docs/orchestration). The workers appear in Paseo so you can inspect their conversations and changes as they work.
