import type { ReactElement } from "react";
import { Text, View } from "react-native";
import { Globe, SquareTerminal } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import type { WorkspaceScriptLinkKind } from "@/utils/workspace-script-links";
import { scriptStatus, scriptToneColorMapping } from "./script-status";

const ThemedGlobe = withUnistyles(Globe);
const ThemedSquareTerminal = withUnistyles(SquareTerminal);

/** A globe for a service, a terminal for a plain script, in the colour of what it is doing. */
export function ScriptIcon({
  script,
  size,
}: {
  script: WorkspaceDescriptor["scripts"][number];
  size: number;
}): ReactElement {
  const Icon = script.type === "service" ? ThemedGlobe : ThemedSquareTerminal;
  return (
    <Icon
      size={size}
      uniProps={scriptToneColorMapping(scriptStatus(script))}
      style={styles.scriptIcon}
    />
  );
}

export function ExitCodeBadge({ code }: { code: number }): ReactElement {
  const { t } = useTranslation();
  const exitTextStyle =
    code === 0 ? styles.exitBadgeText : [styles.exitBadgeText, styles.exitBadgeTextError];
  return (
    <View style={styles.exitBadge}>
      <Text style={exitTextStyle}>{t("workspace.scripts.states.exitCode", { code })}</Text>
    </View>
  );
}

/** The label of a URL route, as the user picks between them. */
export function routeLabelKey(
  kind: WorkspaceScriptLinkKind,
):
  | "workspace.scripts.routes.public"
  | "workspace.scripts.routes.paseo"
  | "workspace.scripts.routes.direct" {
  switch (kind) {
    case "public":
      return "workspace.scripts.routes.public";
    case "paseo":
      return "workspace.scripts.routes.paseo";
    case "direct":
      return "workspace.scripts.routes.direct";
  }
}

const styles = StyleSheet.create((theme) => ({
  scriptIcon: {
    flexShrink: 0,
  },
  exitBadge: {
    paddingHorizontal: theme.spacing[1.5],
    paddingVertical: 1,
    borderRadius: 2,
    backgroundColor: theme.colors.surface2,
  },
  exitBadgeText: {
    fontSize: 10,
    lineHeight: 12,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  exitBadgeTextError: {
    color: theme.colors.statusDanger,
  },
}));
