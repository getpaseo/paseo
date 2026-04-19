import { authServerFetch } from "./auth-server-fetch";

export interface OrgMember {
  id: string;
  userId: string;
  role: "owner" | "admin" | "member";
  createdAt: string;
  user: {
    id: string;
    name: string;
    email: string;
    image: string | null;
  } | null;
}

export async function listOrgMembers(
  orgId: string,
  sessionToken: string | null,
): Promise<OrgMember[]> {
  const res = await authServerFetch(
    `/api/organizations/${encodeURIComponent(orgId)}/members`,
    { sessionToken, method: "GET" },
  );
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) return [];
    throw new Error(`Failed to list org members (${res.status})`);
  }
  const body = (await res.json()) as { members?: OrgMember[] };
  return body.members ?? [];
}
