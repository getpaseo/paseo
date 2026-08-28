import { useCallback, useEffect, useMemo, type ReactNode, type RefObject } from "react";
import { Pressable, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { ArrowLeft, ArrowRight, RotateCw } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import { resolveBrowserUrlDraft } from "@/desktop/browser/url-draft";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { WORKSPACE_SECONDARY_HEADER_HEIGHT } from "@/constants/layout";

const ThemedArrowLeft = withUnistyles(ArrowLeft, (theme) => ({
  color: theme.colors.foregroundMuted,
}));
const ThemedArrowRight = withUnistyles(ArrowRight, (theme) => ({
  color: theme.colors.foregroundMuted,
}));
const ThemedRotateCw = withUnistyles(RotateCw, (theme) => ({
  color: theme.colors.foregroundMuted,
}));
const ThemedUrlInput = withUnistyles(EditingTextInput, (theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
}));

interface ToolbarButtonState {
  hovered?: boolean;
  pressed?: boolean;
}

/** Chrome-row button styling, exported for triggers that own their own Pressable. */
export function toolbarButtonStyle({ hovered, pressed }: ToolbarButtonState): StyleProp<ViewStyle> {
  return [styles.iconButton, (hovered || pressed) && styles.iconButtonHovered];
}

interface ToolbarButtonProps {
  label: string;
  children: ReactNode;
  active?: boolean;
  disabled?: boolean;
  onPress: () => void;
}

export function ToolbarButton({
  label,
  children,
  active = false,
  disabled = false,
  onPress,
}: ToolbarButtonProps) {
  const style = useCallback(
    ({ hovered, pressed }: ToolbarButtonState) => [
      styles.iconButton,
      active && styles.selectorActiveButton,
      (hovered || pressed) && styles.iconButtonHovered,
      disabled && styles.iconButtonDisabled,
    ],
    [active, disabled],
  );
  const accessibilityState = useMemo(() => ({ disabled, selected: active }), [active, disabled]);
  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild disabled={disabled}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={accessibilityState}
          disabled={disabled}
          onPress={onPress}
          style={style}
        >
          {children}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="center" offset={8}>
        <Text style={styles.toolbarTooltipText}>{label}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

export interface BrowserChromeProps {
  url: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onNavigate: (url: string) => void;
  /** Owned by the caller so it can focus the URL bar from keyboard shortcuts. */
  urlInputRef: RefObject<EditingTextInputHandle | null>;
  /** Actions only a real webview can perform (devtools, element selector, …). */
  trailing?: ReactNode;
}

/**
 * Navigation chrome shared by the local webview pane and the mirrored pane, so a
 * remote tab gets the same toolbar as one running on this host.
 */
export function BrowserChrome({
  url,
  canGoBack,
  canGoForward,
  isLoading,
  onBack,
  onForward,
  onReload,
  onNavigate,
  urlInputRef,
  trailing,
}: BrowserChromeProps) {
  const { t } = useTranslation();

  useEffect(() => {
    urlInputRef.current?.replaceText(url);
  }, [url, urlInputRef]);

  const navigateToDraft = useCallback(() => {
    const draft = resolveBrowserUrlDraft(urlInputRef.current?.getText());
    if (draft.status === "navigate") {
      onNavigate(draft.url);
    }
  }, [onNavigate, urlInputRef]);

  return (
    <View style={styles.chromeRow}>
      <View style={styles.chromeLeft}>
        <ToolbarButton
          label={t("workspace.browser.controls.back")}
          disabled={!canGoBack}
          onPress={onBack}
        >
          <ThemedArrowLeft size={16} />
        </ToolbarButton>
        <ToolbarButton
          label={t("workspace.browser.controls.forward")}
          disabled={!canGoForward}
          onPress={onForward}
        >
          <ThemedArrowRight size={16} />
        </ToolbarButton>
        <ToolbarButton
          label={
            isLoading
              ? t("workspace.browser.controls.stopLoading")
              : t("workspace.browser.controls.refresh")
          }
          onPress={onReload}
        >
          <ThemedRotateCw size={16} />
        </ToolbarButton>
      </View>
      <View style={styles.urlBarWrap}>
        <ThemedUrlInput
          accessibilityLabel={t("workspace.browser.controls.browserUrl")}
          autoCapitalize="none"
          autoCorrect={false}
          initialValue={url}
          onSubmitEditing={navigateToDraft}
          placeholder={t("workspace.browser.controls.enterUrl")}
          ref={urlInputRef}
          returnKeyType="go"
          selectTextOnFocus
          style={styles.urlInput}
        />
      </View>
      {trailing ? <View style={styles.chromeRight}>{trailing}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  chromeRow: {
    height: WORKSPACE_SECONDARY_HEADER_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  chromeLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 0,
  },
  chromeRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 0,
  },
  iconButton: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  selectorActiveButton: {
    backgroundColor: `${String(theme.colors.accent)}20`,
  },
  iconButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  iconButtonDisabled: {
    opacity: 0.45,
  },
  toolbarTooltipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.popoverForeground,
  },
  urlBarWrap: {
    flex: 1,
    minWidth: 0,
    height: 28,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[2],
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  urlInput: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.base,
    paddingVertical: 0,
    paddingHorizontal: 0,
    outlineWidth: 0,
    color: theme.colors.foreground,
  },
}));
