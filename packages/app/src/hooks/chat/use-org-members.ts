import { useQuery } from "@tanstack/react-query";
import {
  desktopAuthGetOrgMembers,
  type DesktopOrgMember,
} from "@/desktop/auth/desktop-auth";
import { webGetOrgMembers } from "@/desktop/auth/web-auth-api";
import { getIsElectron } from "@/constants/platform";
import type { OrgMember } from "@/api/organizations";
import { useChatStore } from "@/stores/chat-store";

export const orgMembersKey = (orgId: string) => ["chat", "orgMembers", orgId] as const;

function toOrgMember(m: DesktopOrgMember): OrgMember {
  const role = (["owner", "admin", "member"].includes(m.role)
    ? m.role
    : "member") as OrgMember["role"];
  return {
    id: m.id,
    userId: m.userId,
    role,
    createdAt: m.createdAt,
    user: m.user,
  };
}

export function useOrgMembersQuery(orgId: string | undefined, _sessionToken: string | null) {
  const setMembers = useChatStore((s) => s.setOrgMembersForOrg);
  const cached = useChatStore((s) => (orgId ? s.orgMembersByOrg[orgId] : undefined));
  return useQuery<OrgMember[]>({
    queryKey: orgMembersKey(orgId ?? ""),
    enabled: !!orgId,
    queryFn: async () => {
      const { members } = getIsElectron()
        ? await desktopAuthGetOrgMembers(orgId!)
        : await webGetOrgMembers(orgId!);
      const mapped = members.map(toOrgMember);
      setMembers(orgId!, mapped);
      return mapped;
    },
    // Instant paint from cache; fresh fetch replaces on arrival.
    initialData: orgId ? cached : undefined,
    initialDataUpdatedAt: 0,
    staleTime: 60_000,
  });
}
