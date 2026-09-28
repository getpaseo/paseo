import { describe, expect, it, vi } from "vitest";
import type {
  DaemonClient,
  FetchRecentProviderSessionEntry,
} from "@getpaseo/client/internal/daemon-client";
import { importResumeSession } from "./resume-session-import";

const entry: FetchRecentProviderSessionEntry = {
  providerId: "omp",
  providerLabel: "Oh My Pi",
  providerHandleId: "omp-session-1",
  cwd: "/repo/paseo",
  title: "Continue CLI work",
  firstPromptPreview: "Continue CLI work",
  lastPromptPreview: "Continue CLI work",
  lastActivityAt: "2026-09-28T10:00:00.000Z",
};

function createClient() {
  const createWorkspace = vi.fn(
    async () =>
      ({
        workspace: { id: "workspace-resumed" },
        error: null,
      }) as Awaited<ReturnType<DaemonClient["createWorkspace"]>>,
  );
  const importAgent = vi.fn(
    async () =>
      ({
        id: "agent-resumed",
        cwd: entry.cwd,
      }) as Awaited<ReturnType<DaemonClient["importAgent"]>>,
  );
  const archiveWorkspace = vi.fn(
    async () =>
      ({
        error: null,
      }) as Awaited<ReturnType<DaemonClient["archiveWorkspace"]>>,
  );
  return { createWorkspace, importAgent, archiveWorkspace };
}

describe("importResumeSession", () => {
  it("creates a named workspace and imports the OMP session into it", async () => {
    const client = createClient();

    const agent = await importResumeSession(client, entry);

    expect(client.createWorkspace).toHaveBeenCalledWith({
      source: { kind: "directory", path: entry.cwd },
      title: "Continue CLI work",
    });
    expect(client.importAgent).toHaveBeenCalledWith({
      providerId: "omp",
      providerHandleId: "omp-session-1",
      cwd: entry.cwd,
      workspaceId: "workspace-resumed",
    });
    expect(client.archiveWorkspace).not.toHaveBeenCalled();
    expect(agent.id).toBe("agent-resumed");
  });

  it("archives the new workspace when the provider session import fails", async () => {
    const client = createClient();
    client.importAgent.mockRejectedValueOnce(new Error("Session is already imported"));

    await expect(importResumeSession(client, entry)).rejects.toThrow("Session is already imported");

    expect(client.archiveWorkspace).toHaveBeenCalledWith("workspace-resumed");
  });
});
