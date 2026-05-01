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
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useSessionStore } from "@/stores/session-store";
import { useActiveOrgId } from "@/stores/active-org-store";
import { useAuthSession } from "@/desktop/hooks/use-auth-session";
import { upsertProjectRegistry } from "@/api/project-registry";

// Per-device record of which org each project_key was first synced to. Keeps
// the auto-sync from cloning a project across every org the user switches
// into — once a project has a "home" org, switching orgs is a no-op for sync.
// Explicit "+" actions in the projects sidebar can still register a project
// in another org via a direct upsert path that bypasses this hook.
const HOME_ORG_STORAGE_KEY = "@hubcode:project-home-orgs";

type HomeOrgMap = Record<string, string>;

async function loadHomeOrgMap(): Promise<HomeOrgMap> {
  try {
    const raw = await AsyncStorage.getItem(HOME_ORG_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as HomeOrgMap) : {};
  } catch {
    return {};
  }
}

async function saveHomeOrgMap(map: HomeOrgMap): Promise<void> {
  try {
    await AsyncStorage.setItem(HOME_ORG_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // best-effort
  }
}

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
        const homeOrgs = await loadHomeOrgMap();
        let homeOrgsDirty = false;
        for (const project of projects) {
          const home = homeOrgs[project.projectKey];
          if (home && home !== activeOrgId) {
            // Project already has a home org — don't propagate to the
            // currently active one. The user must explicitly re-add it via
            // the sidebar "+" if they want it in this org too.
            continue;
          }
          if (!home) {
            homeOrgs[project.projectKey] = activeOrgId;
            homeOrgsDirty = true;
          }
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
            // Auth errors (signed out, session expired, not a member of org)
            // are part of normal flow — don't spam the log; the sync just
            // becomes a no-op until the user signs in or switches org.
            const message = err instanceof Error ? err.message : String(err);
            if (
              message.includes("Unauthorized") ||
              message.includes("Forbidden") ||
              message.startsWith("Not authenticated") ||
              message.startsWith("Session expired") ||
              message.startsWith("Not a member of")
            ) {
              continue;
            }
            console.warn("[project-registry] upsert failed for", project.projectKey, message);
          }
        }
        if (homeOrgsDirty) {
          await saveHomeOrgMap(homeOrgs);
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
