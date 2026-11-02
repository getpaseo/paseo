# Live changes

See which files differ from `HEAD` in a workspace panel that updates as you edit. The daemon watches the workspace and pushes the changed-file list to the panel; the panel never polls.

Open **Open live changes** in the Command Center, or pick **Live changes** from the workspace tab menu. Each open panel runs its own watcher, which stops when you close the panel.

The watcher reads the working tree recursively, so a checkout with very large ignored directories makes it slower to start.
