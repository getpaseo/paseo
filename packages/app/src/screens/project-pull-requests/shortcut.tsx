import { useCallback, useState } from "react";
import { Text, View, type GestureResponderEvent } from "react-native";
import { GitPullRequest } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import type { SidebarProjectHostTarget } from "@/utils/sidebar-project-row-model";
import { ProjectPullRequestsOverlay } from "./view";

export function ProjectPullRequestsShortcut({
  target,
  displayName,
  visible,
}: {
  target: SidebarProjectHostTarget;
  displayName: string;
  visible: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const show = useCallback((event: GestureResponderEvent) => {
    event.stopPropagation();
    setOpen(true);
  }, []);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <View style={!visible && styles.hidden} pointerEvents={visible ? "auto" : "none"}>
        <Tooltip enabledOnDesktop enabledOnMobile={false}>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="xs"
              leftIcon={GitPullRequest}
              onPress={show}
              disabled={!visible}
              accessibilityLabel={t("projectPullRequests.shortcut", { project: displayName })}
              testID={`sidebar-project-pull-requests-${target.projectId}`}
            />
          </TooltipTrigger>
          <TooltipContent>
            <Text style={styles.tooltipText}>{t("projectPullRequests.title")}</Text>
          </TooltipContent>
        </Tooltip>
      </View>
      {open ? (
        <ProjectPullRequestsOverlay target={target} displayName={displayName} onClose={close} />
      ) : null}
    </>
  );
}
const styles = StyleSheet.create((theme) => ({
  hidden: { opacity: 0 },
  tooltipText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
}));
