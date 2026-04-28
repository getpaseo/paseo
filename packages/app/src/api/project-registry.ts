import { authServerFetch } from "./auth-server-fetch";

export interface ProjectRegistryOwner {
  userId: string;
  name: string;
  email: string;
  image: string | null;
}

export interface ProjectRegistryEntry {
  id: string;
  orgId: string;
  projectKey: string;
  name: string;
  description: string | null;
  iconEmoji: string | null;
  iconColor: string | null;
  gitRemoteUrl: string | null;
  defaultBranch: string | null;
  lastSeenAt: string;
  createdAt: string;
  owner: ProjectRegistryOwner;
}

export interface UpsertProjectParams {
  orgId: string;
  projectKey: string;
  name: string;
  description?: string | null;
  gitRemoteUrl?: string | null;
  defaultBranch?: string | null;
  iconEmoji?: string | null;
  iconColor?: string | null;
}

export async function upsertProjectRegistry(
  params: UpsertProjectParams,
  sessionToken: string | null,
): Promise<{ id: string; created: boolean }> {
  const res = await authServerFetch("/api/projects/upsert", {
    method: "POST",
    sessionToken,
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Failed to upsert project (${res.status})`);
  }
  const body = (await res.json()) as { id: string; created: boolean };
  return body;
}

export async function listOnlineProjects(
  orgId: string,
  sessionToken: string | null,
): Promise<ProjectRegistryEntry[]> {
  const res = await authServerFetch(`/api/projects?orgId=${encodeURIComponent(orgId)}`, {
    sessionToken,
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) return [];
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Failed to list projects (${res.status})`);
  }
  const body = (await res.json()) as { projects?: ProjectRegistryEntry[] };
  return body.projects ?? [];
}

export async function deleteOnlineProject(id: string, sessionToken: string | null): Promise<void> {
  const res = await authServerFetch(`/api/projects/${encodeURIComponent(id)}`, {
    method: "DELETE",
    sessionToken,
  });
  if (!res.ok && res.status !== 404) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Failed to delete project (${res.status})`);
  }
}
