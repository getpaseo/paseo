import React, { useCallback, useEffect, useState } from "react";
import { Alert, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import { FormTextInput } from "@/components/ui/form-field";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { settingsStyles } from "@/styles/settings";

const TERMINAL_SHELL_LABELS: Record<string, string> = {
  default: "Default (system shell)",
  pwsh: "PowerShell 7 (pwsh)",
  powershell: "Windows PowerShell",
  cmd: "Command Prompt (cmd.exe)",
  wsl: "WSL (Linux)",
  "git-bash": "Git Bash",
  zsh: "Zsh",
  bash: "Bash",
  fish: "Fish",
  nu: "Nushell (nu)",
  elvish: "Elvish",
  custom: "Custom executable path",
};

function terminalShellLabel(shell: string): string {
  return TERMINAL_SHELL_LABELS[shell] ?? shell;
}

function TerminalShellMenuItem({
  value,
  selected,
  onChange,
}: {
  value: string;
  selected: boolean;
  onChange: (value: string) => void;
}) {
  const handleSelect = useCallback(() => {
    onChange(value);
  }, [onChange, value]);
  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect}>
      {terminalShellLabel(value)}
    </DropdownMenuItem>
  );
}

export function TerminalShellCard({ serverId }: { serverId: string }) {
  const isConnected = useHostRuntimeIsConnected(serverId);
  const { config, patchConfig } = useDaemonConfig(serverId);
  const client = useHostRuntimeClient(serverId);
  // COMPAT(terminalShell): hosts before v0.3.0 cannot honor a configured shell,
  // so the setting is hidden rather than silently ignored.
  const supportsTerminalShell = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.terminalShell === true,
  );
  const [shells, setShells] = useState<string[] | null>(null);
  const selected = config?.terminalShell ?? "default";
  const customPath = config?.customTerminalShellPath ?? "";
  const [customPathValue, setCustomPathValue] = useState(customPath);

  useEffect(() => {
    setCustomPathValue(customPath);
  }, [customPath]);

  // The host answers which shells it has, so this is right from any client.
  useEffect(() => {
    if (!client || !isConnected || !supportsTerminalShell) {
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const payload = await client.listTerminalShells();
        if (!cancelled && payload.shells.length > 0) {
          setShells(payload.shells);
        }
      } catch (error) {
        console.error("[HostPage] Failed to list terminal shells", error);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [client, isConnected, supportsTerminalShell]);

  const patch = useCallback(
    (next: { terminalShell?: string; customTerminalShellPath?: string }) => {
      void patchConfig(next).catch((error) => {
        console.error("[HostPage] Failed to update terminal shell", error);
        Alert.alert(
          "Unable to update terminal shell",
          error instanceof Error ? error.message : String(error),
        );
      });
    },
    [patchConfig],
  );

  const handleShellChange = useCallback((next: string) => patch({ terminalShell: next }), [patch]);
  const commitCustomPath = useCallback(() => {
    if (customPathValue !== customPath) {
      patch({ customTerminalShellPath: customPathValue });
    }
  }, [customPath, customPathValue, patch]);

  if (!isConnected || !supportsTerminalShell) return null;

  const options = shells ?? [selected];

  return (
    <View style={settingsStyles.card} testID="host-page-terminal-shell-card">
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>Shell</Text>
          <Text style={settingsStyles.rowHint}>
            {selected === "wsl"
              ? "Shows shells installed on this host's PATH. WSL runs in its own OS, so terminal agent activity and notifications are not reported from it."
              : "Shell for new terminal tabs. Shows shells installed on this host's PATH."}
          </Text>
        </View>
        <DropdownMenu>
          <DropdownTrigger accessibilityRole="button" accessibilityLabel="Terminal shell">
            <Text style={settingsStyles.rowTitle}>{terminalShellLabel(selected)}</Text>
          </DropdownTrigger>
          <DropdownMenuContent side="bottom" align="end" width={260}>
            {options.map((value) => (
              <TerminalShellMenuItem
                key={value}
                value={value}
                selected={selected === value}
                onChange={handleShellChange}
              />
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </View>
      {selected === "custom" ? (
        <View style={[settingsStyles.row, settingsStyles.rowBorder, terminalShellStyles.customRow]}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>Custom shell path</Text>
            <Text style={settingsStyles.rowHint}>
              Absolute path on this host, for example C:\Program Files\PowerShell\7\pwsh.exe
            </Text>
          </View>
          <FormTextInput
            initialValue={customPath}
            resetKey={customPath}
            onChangeText={setCustomPathValue}
            onBlur={commitCustomPath}
            onSubmitEditing={commitCustomPath}
            placeholder="/usr/local/bin/fish"
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            returnKeyType="done"
            accessibilityLabel="Custom shell path"
            testID="host-page-terminal-shell-custom-path-input"
            style={terminalShellStyles.customInput}
          />
        </View>
      ) : null}
    </View>
  );
}

// The path is long, so it gets its own stacked row rather than sitting in the
// narrow control column beside the label.
const terminalShellStyles = StyleSheet.create((theme) => ({
  customRow: {
    alignItems: "stretch",
    flexDirection: "column",
    gap: theme.spacing[2],
  },
  customInput: {
    width: "100%",
  },
}));
