import { useCallback, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { invokeDesktopCommand } from "@/desktop/electron/invoke";
import { getIsElectron } from "@/constants/platform";

export interface ShareInfo {
  shareId: string;
  token: string;
  shareUrl: string;
  accessLevel: string;
  expiresAt: string;
}

interface CreateShareParams {
  daemonSessionId: string;
  serverId: string;
  orgId: string;
  accessLevel: "read_only" | "full_access";
  pairingUrl?: string;
  allowedUserIds: string[];
  expiresInMinutes?: number;
}

/**
 * Hook for creating and managing session shares.
 * Works on desktop (via IPC → auth-server) and web/mobile (direct API call).
 */
export function useShareSession() {
  const [shareInfo, setShareInfo] = useState<ShareInfo | null>(null);

  const createMutation = useMutation({
    mutationFn: async (params: CreateShareParams) => {
      if (getIsElectron()) {
        // Desktop: via IPC
        const raw = await invokeDesktopCommand<unknown>(
          "desktop_auth_create_share",
          params as unknown as Record<string, unknown>,
        );
        return raw as ShareInfo;
      }
      // Web/mobile: direct API call (would need session token in cookie or header)
      const authServerUrl = __DEV__ ? "http://localhost:3002" : "https://auth.hubcode.ai";
      const response = await fetch(`${authServerUrl}/api/sessions/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? "Failed to create share");
      }
      return (await response.json()) as ShareInfo;
    },
    onSuccess: (data) => {
      setShareInfo(data);
    },
  });

  const revokeMutation = useMutation({
    mutationFn: async (token: string) => {
      if (getIsElectron()) {
        await invokeDesktopCommand("desktop_auth_revoke_share", { token });
        return;
      }
      const authServerUrl = __DEV__ ? "http://localhost:3002" : "https://auth.hubcode.ai";
      const response = await fetch(
        `${authServerUrl}/api/sessions/share/${encodeURIComponent(token)}`,
        {
          method: "DELETE",
        },
      );
      if (!response.ok) {
        throw new Error("Failed to revoke share");
      }
    },
    onSuccess: () => {
      setShareInfo(null);
    },
  });

  const createShare = useCallback(
    (params: CreateShareParams) => createMutation.mutateAsync(params),
    [createMutation],
  );

  const revokeShare = useCallback(
    (token: string) => revokeMutation.mutateAsync(token),
    [revokeMutation],
  );

  return {
    shareInfo,
    createShare,
    isCreating: createMutation.isPending,
    createError: createMutation.error instanceof Error ? createMutation.error.message : null,
    revokeShare,
    isRevoking: revokeMutation.isPending,
  };
}
