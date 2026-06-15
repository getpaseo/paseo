import { test, expect } from "vitest";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { DaemonClient } from "./test-utils/index.js";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";

// workspace.create has four reject branches before it ever touches the
// registries; this pins each one's errorCode (or, for project-not-found, its
// message) as seen by the daemon client, so the CLI/app contract on top of them
// stays covered.
test("workspace.create surfaces each early-reject error branch", async () => {
  const daemon = await createTestPaseoDaemon();
  const missingDir = path.join(tmpdir(), `paseo-workspace-create-missing-${Date.now()}`);
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.1.82",
  });

  try {
    await client.connect();

    // local backing without a cwd -> cwd_required
    const cwdRequired = await client.createWorkspace({ backing: "local" });
    expect(cwdRequired.workspace).toBeNull();
    expect(cwdRequired.errorCode).toBe("cwd_required");

    // local backing pointed at a path that does not exist -> directory_not_found
    const directoryNotFound = await client.createWorkspace({
      backing: "local",
      cwd: missingDir,
    });
    expect(directoryNotFound.workspace).toBeNull();
    expect(directoryNotFound.errorCode).toBe("directory_not_found");
    expect(directoryNotFound.error).toContain(missingDir);

    // worktree backing without a cwd or projectId -> source_required
    const sourceRequired = await client.createWorkspace({ backing: "worktree", branch: "feat" });
    expect(sourceRequired.workspace).toBeNull();
    expect(sourceRequired.errorCode).toBe("source_required");

    // worktree backing with an unknown projectId -> project-not-found message
    // (surfaced via the generic catch, so it carries an error but no errorCode)
    const projectNotFound = await client.createWorkspace({
      backing: "worktree",
      projectId: "proj-does-not-exist",
      branch: "feat",
    });
    expect(projectNotFound.workspace).toBeNull();
    expect(projectNotFound.error).toContain("Project not found: proj-does-not-exist");
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
    rmSync(missingDir, { recursive: true, force: true });
  }
}, 180000);
