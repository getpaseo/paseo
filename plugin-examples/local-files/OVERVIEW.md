# Local Files

Copy an ignored file such as `.env` from your current device into a Git project on a connected Paseo host. You can pick a file even if this device has no daemon or matching project.

Select the host and project, choose the file, and review the exact destination before copying. The plugin accepts regular files up to 1 MiB and leaves existing files in place. File contents do not appear in the interface. The imported file is readable by processes running as the daemon user.

Add a matching `.worktreeinclude` pattern in the destination checkout to copy the file into future worktrees. This example requires a Paseo build with the experimental plugin file transfer API.
