/**
 * Keeps the online `project_registry` in sync with whatever projects the
 * user's daemons are currently exposing. Runs as a background effect: every
 * time the workspace list (for any daemon) changes and we have an active org
 * + auth session, we upsert one entry per unique projectId.
 *
 * The sync is best-effort — failures are logged but never surface to the UI.
 * Only lightweight, non-sensitive fields are shipped (projectId as stable key,
 * display name, git remote URL when available).
 */

import { useEffect, useRef } from "react";
import { useSessionStore } from "@/stores/session-store";
import { useActiveOrgId } from "@/stores/active-org-store";
import { useAuthSession } from "@/desktop/hooks/use-auth-session";
import { upsertProjectRegistry } from "@/api/project-registry";

interface ProjectSyncCandidate {
  projectKey: string;
  name: string;
  gitRemoteUrl: string | null;
}

/**
 * Derive a minimal set of projects from all loaded workspaces across servers.
 * Key dedup priority: if any workspace under the project has a remoteUrl,
 * prefer the `remote:...` key so multiple users' daemons collapse into one
 * entry; otherwise fall back to the daemon-local projectId.
 */
function deriveProjectsFromSessions(
  sessionsMap: ReturnType<typeof useSessionStore.getState>["sessions"],
): ProjectSyncCandidate[] {
  const byKey = new Map<string, ProjectSyncCandidate>();
  for (const session of Object.values(sessionsMap)) {
    if (!session?.workspaces) continue;
    for (const ws of session.workspaces.values()) {
      if (!ws.projectId) continue;
      const remoteKey = deriveRemoteProjectKey(ws.gitRemoteUrl ?? null);
      const key = remoteKey ?? ws.projectId;
      const existing = byKey.get(key);
      if (existing && existing.gitRemoteUrl) continue;
      byKey.set(key, {
        projectKey: key,
        name: ws.projectDisplayName || ws.projectId,
        gitRemoteUrl: ws.gitRemoteUrl ?? null,
      });
    }
  }
  return Array.from(byKey.values());
}

function deriveRemoteProjectKey(remoteUrl: string | null): string | null {
  if (!remoteUrl) return null;
  // Normalize git@github.com:foo/bar.git → github.com/foo/bar
  // and https://github.com/foo/bar(.git) → github.com/foo/bar
  const sshMatch = remoteUrl.match(/^[^@]+@([^:]+):(.+?)(?:\.git)?$/);
  if (sshMatch) return `remote:${sshMatch[1]}/${sshMatch[2]}`;
  try {
    const url = new URL(remoteUrl);
    const host = url.host;
    const path = url.pathname.replace(/^\//, "").replace(/\.git$/, "");
    if (host && path) return `remote:${host}/${path}`;
  } catch {
    /* not a URL */
  }
  return null;
}

const UPSERT_DEBOUNCE_MS = 2_000;

export function useProjectRegistrySync(): void {
  const sessions = useSessionStore((s) => s.sessions);
  const activeOrgId = useActiveOrgId();
  const { session } = useAuthSession();
  const sessionToken = session?.sessionToken ?? "";
  const lastSyncKeyRef = useRef<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!activeOrgId) return;
    const projects = deriveProjectsFromSessions(sessions);
    if (projects.length === 0) return;

    // Cheap fingerprint so we don't re-POST on every unrelated workspace
    // mutation (diff updates, agent status, etc.).
    const fingerprint = `${activeOrgId}|${projects
      .map((p) => `${p.projectKey}:${p.name}:${p.gitRemoteUrl ?? ""}`)
      .sort()
      .join(",")}`;
    if (fingerprint === lastSyncKeyRef.current) return;

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      lastSyncKeyRef.current = fingerprint;
      void (async () => {
        for (const project of projects) {
          try {
            await upsertProjectRegistry(
              {
                orgId: activeOrgId,
                projectKey: project.projectKey,
                name: project.name,
                gitRemoteUrl: project.gitRemoteUrl,
              },
              sessionToken || null,
            );
          } catch (err) {
            console.warn(
              "[project-registry] upsert failed for",
              project.projectKey,
              err instanceof Error ? err.message : err,
            );
          }
        }
      })();
    }, UPSERT_DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [sessions, activeOrgId, sessionToken]);
}
