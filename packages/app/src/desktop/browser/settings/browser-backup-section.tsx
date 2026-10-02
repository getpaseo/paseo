import { useCallback, useRef, useState } from "react";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { SettingsCard, SettingsRow } from "@/components/settings";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { AdaptiveTextInput } from "@/components/adaptive-text-input";
import { Button } from "@/components/ui/button";
import { getDesktopHost } from "@/desktop/host";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";
import { useFetchQuery } from "@/data/query";

export function BrowserBackupSection({ serverId }: { serverId: string }) {
  const client = useHostRuntimeClient(serverId);
  const hostProfile = useHostFeature(serverId, "browserScreencast");
  const hostBackup = useHostFeature(serverId, "browserProfileImport");
  const [passphrase, setPassphrase] = useState("");
  const passphraseInput = useRef<EditingTextInputHandle>(null);
  const queryClient = useQueryClient();
  const status = useFetchQuery({
    queryKey: ["browser-profile-status"],
    queryFn: async () => {
      const read = getDesktopHost()?.browser?.profileStatus;
      if (!read) throw new Error("Update the desktop app to back up browser logins.");
      return read();
    },
    enabled: !hostProfile,
    dataShape: "value",
    staleTimeMs: 0,
  });
  const backup = useMutation({
    mutationFn: async (action: "export" | "restore") => {
      if (hostProfile) {
        if (!hostBackup || !client)
          throw new Error("Update and connect the host to back up its browser profile.");
        const file = getDesktopHost()?.browser?.backupFile;
        if (!file) throw new Error("Update the desktop app to save encrypted backups.");
        let encrypted: string | undefined;
        if (action === "restore") {
          const selected = await file({ action: "read" });
          if (!selected.ok) throw new Error(selected.error);
          if (selected.cancelled)
            return {
              cancelled: true,
              cookieCount: 0,
              passwordCount: 0,
              skippedCookies: 0,
              skippedPasswords: 0,
            };
          encrypted = selected.encrypted;
        }
        const result = await client.backupBrowserProfile({
          action,
          passphrase,
          ...(encrypted ? { encrypted } : {}),
        });
        if (result.error) throw new Error(result.error);
        if (action === "export") {
          const saved = await file({ action: "save", encrypted: result.encrypted! });
          if (!saved.ok) throw new Error(saved.error);
          return { ...result, cancelled: saved.cancelled };
        }
        return { ...result, cancelled: false };
      }
      const run = getDesktopHost()?.browser?.backup;
      if (!run) throw new Error("Update the desktop app to back up browser logins.");
      const result = await run({ action, passphrase });
      if (!result.ok) throw new Error(result.error);
      return result;
    },
    onSettled: () => {
      setPassphrase("");
      passphraseInput.current?.replaceText("");
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["browser-saved-passwords"] });
      void queryClient.invalidateQueries({ queryKey: ["browser-profile-status"] });
    },
  });
  const unavailable = hostProfile ? !hostBackup : status.data?.available === false;
  const unavailableError = hostProfile
    ? "Update the host to enable encrypted profile backup."
    : "Unlock the system keychain to keep session logins and save passwords.";
  const save = useCallback(() => backup.mutate("export"), [backup]);
  const restore = useCallback(() => backup.mutate("restore"), [backup]);
  const hint =
    backup.data && !backup.data.cancelled
      ? `${backup.data.cookieCount} cookies, ${backup.data.passwordCount} passwords; preserved ${backup.data.skippedCookies} existing/expired cookies and ${backup.data.skippedPasswords} existing passwords.`
      : `${hostProfile ? "Host browser / handoff" : "This device’s desktop browser"}. Restore adds missing logins and keeps existing ones.`;
  return (
    <SettingsSection
      title="Encrypted browser backup"
      info="Save cookies and passwords with a separate passphrase. Keep the passphrase safe; it cannot be recovered. Site logins can expire or be revoked independently of the backup."
    >
      <SettingsCard>
        <SettingsRow
          label={hostProfile ? "Host browser profile" : "Desktop browser profile"}
          hint={hint}
          error={
            status.error?.message ??
            status.data?.error ??
            (unavailable ? unavailableError : undefined)
          }
        />
        <SettingsRow label="Backup passphrase" hint="At least 12 characters">
          <AdaptiveTextInput
            accessibilityLabel="Backup passphrase"
            ref={passphraseInput}
            onChangeText={setPassphrase}
            secureTextEntry
            autoComplete="off"
          />
        </SettingsRow>
        <SettingsRow label="Back up or restore" error={backup.error?.message}>
          <Button
            variant="outline"
            size="sm"
            disabled={backup.isPending || passphrase.length < 12 || unavailable}
            loading={backup.isPending && backup.variables === "export"}
            onPress={save}
          >
            Save backup
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={backup.isPending || passphrase.length < 12 || unavailable}
            loading={backup.isPending && backup.variables === "restore"}
            onPress={restore}
          >
            Restore backup
          </Button>
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  );
}
