import { useCallback, useMemo, useState, type ReactNode } from "react";
import {
  Pressable,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import Markdown, { type ASTNode } from "react-native-markdown-display";
import { ChevronRight, ClipboardList } from "lucide-react-native";
import { StyleSheet, useUnistyles, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { isNative } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { Theme } from "@/styles/theme";
import { createMarkdownStyles } from "@/styles/markdown-styles";
import { getMarkdownListMarker } from "@/utils/markdown-list";
import { splitPlanHeading } from "@/utils/plan-heading";

type PlanOutcome = "approved" | "rejected" | "superseded";

const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedClipboardList = withUnistyles(ClipboardList);
const mutedIconColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundIconColor = (theme: Theme) => ({ color: theme.colors.foreground });

type MarkdownRuleStyles = Record<string, TextStyle & ViewStyle & { [key: string]: unknown }>;

function MarkdownInlineText({
  inheritedStyle,
  ruleStyle,
  children,
}: {
  inheritedStyle: StyleProp<TextStyle>;
  ruleStyle: StyleProp<TextStyle>;
  children: ReactNode;
}) {
  const style = useMemo(() => [inheritedStyle, ruleStyle], [inheritedStyle, ruleStyle]);
  return <Text style={style}>{children}</Text>;
}

function MarkdownListItemContent({
  contentStyle,
  children,
}: {
  contentStyle: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const style = useMemo(() => [contentStyle, LIST_ITEM_CONTENT_INNER], [contentStyle]);
  return <View style={style}>{children}</View>;
}

function MarkdownParagraph({
  paragraphStyle,
  isLastChild,
  children,
}: {
  paragraphStyle: StyleProp<ViewStyle>;
  isLastChild: boolean;
  children: ReactNode;
}) {
  const style = useMemo<StyleProp<ViewStyle>>(
    () => [paragraphStyle, isLastChild ? PARAGRAPH_LAST_CHILD : null],
    [paragraphStyle, isLastChild],
  );
  return <View style={style}>{children}</View>;
}

function createPlanMarkdownRules() {
  return {
    text: (
      node: ASTNode,
      _children: ReactNode[],
      _parent: ASTNode[],
      styles: MarkdownRuleStyles,
      inheritedStyles: TextStyle = {},
    ) => (
      <MarkdownInlineText key={node.key} inheritedStyle={inheritedStyles} ruleStyle={styles.text}>
        {node.content}
      </MarkdownInlineText>
    ),
    textgroup: (
      node: ASTNode,
      children: ReactNode[],
      _parent: ASTNode[],
      styles: MarkdownRuleStyles,
      inheritedStyles: TextStyle = {},
    ) => (
      <MarkdownInlineText
        key={node.key}
        inheritedStyle={inheritedStyles}
        ruleStyle={styles.textgroup}
      >
        {children}
      </MarkdownInlineText>
    ),
    code_block: (
      node: ASTNode,
      _children: ReactNode[],
      _parent: ASTNode[],
      styles: MarkdownRuleStyles,
      inheritedStyles: TextStyle = {},
    ) => (
      <MarkdownInlineText
        key={node.key}
        inheritedStyle={inheritedStyles}
        ruleStyle={styles.code_block}
      >
        {node.content}
      </MarkdownInlineText>
    ),
    fence: (
      node: ASTNode,
      _children: ReactNode[],
      _parent: ASTNode[],
      styles: MarkdownRuleStyles,
      inheritedStyles: TextStyle = {},
    ) => (
      <MarkdownInlineText key={node.key} inheritedStyle={inheritedStyles} ruleStyle={styles.fence}>
        {node.content}
      </MarkdownInlineText>
    ),
    code_inline: (
      node: ASTNode,
      _children: ReactNode[],
      _parent: ASTNode[],
      styles: MarkdownRuleStyles,
      inheritedStyles: TextStyle = {},
    ) => (
      <MarkdownInlineText
        key={node.key}
        inheritedStyle={inheritedStyles}
        ruleStyle={styles.code_inline}
      >
        {node.content}
      </MarkdownInlineText>
    ),
    bullet_list: (
      node: ASTNode,
      children: ReactNode[],
      _parent: ASTNode[],
      styles: MarkdownRuleStyles,
    ) => (
      <View key={node.key} style={styles.bullet_list}>
        {children}
      </View>
    ),
    ordered_list: (
      node: ASTNode,
      children: ReactNode[],
      _parent: ASTNode[],
      styles: MarkdownRuleStyles,
    ) => (
      <View key={node.key} style={styles.ordered_list}>
        {children}
      </View>
    ),
    list_item: (
      node: ASTNode,
      children: ReactNode[],
      parent: ASTNode[],
      styles: MarkdownRuleStyles,
    ) => {
      const { isOrdered, marker } = getMarkdownListMarker(node, parent);
      const iconStyle = isOrdered ? styles.ordered_list_icon : styles.bullet_list_icon;
      const contentStyle = isOrdered ? styles.ordered_list_content : styles.bullet_list_content;

      return (
        <View key={node.key} style={styles.list_item}>
          <Text style={iconStyle}>{marker}</Text>
          <MarkdownListItemContent contentStyle={contentStyle}>{children}</MarkdownListItemContent>
        </View>
      );
    },
    paragraph: (
      node: ASTNode,
      children: ReactNode[],
      parent: ASTNode[],
      styles: MarkdownRuleStyles,
    ) => {
      const isLastChild = parent[0]?.children?.at(-1)?.key === node.key;
      return (
        <MarkdownParagraph
          key={node.key}
          paragraphStyle={styles.paragraph}
          isLastChild={isLastChild}
        >
          {children}
        </MarkdownParagraph>
      );
    },
  };
}

export function PlanCard({
  title,
  description,
  text,
  footer,
  outcome,
  collapsible = false,
  disableOuterSpacing = false,
  testID,
}: {
  title?: string;
  description?: string;
  text: string;
  footer?: ReactNode;
  outcome?: PlanOutcome;
  collapsible?: boolean;
  disableOuterSpacing?: boolean;
  testID?: string;
}) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const markdownStyles = createMarkdownStyles(theme);
  const markdownRules = createPlanMarkdownRules();
  const { planHeading, bodyText } = useMemo(
    () => (collapsible ? splitPlanHeading(text) : { planHeading: undefined, bodyText: text }),
    [collapsible, text],
  );
  const resolvedTitle = title ?? planHeading ?? t("agentStream.permission.plan");
  // Collapsible cards (resolved plans in the timeline) start collapsed so the timeline
  // stays scannable; the live permission card is never collapsible.
  const [expanded, setExpanded] = useState(false);
  // Mirror the tool-call badge: a left icon slot that swaps to the expand chevron on
  // hover (web only — native always shows the icon and taps to expand).
  const [isHovered, setIsHovered] = useState(false);
  const showBody = !collapsible || expanded;
  const outcomeMeta = useMemo(() => {
    if (!outcome) {
      return null;
    }
    if (outcome === "approved") {
      return {
        backgroundColor: theme.colors.statusSuccess,
        color: "#ffffff",
        label: t("agentStream.permission.planApproved"),
      };
    }
    if (outcome === "rejected") {
      return {
        backgroundColor: theme.colors.statusDanger,
        color: "#ffffff",
        label: t("agentStream.permission.planRejected"),
      };
    }
    return {
      backgroundColor: theme.colors.surface3,
      color: theme.colors.foregroundMuted,
      label: t("agentStream.permission.planDismissed"),
    };
  }, [
    outcome,
    theme.colors.statusSuccess,
    theme.colors.statusDanger,
    theme.colors.surface3,
    theme.colors.foregroundMuted,
    t,
  ]);
  const outcomePillStyle = useMemo(
    () =>
      outcomeMeta ? [styles.outcomePill, { backgroundColor: outcomeMeta.backgroundColor }] : null,
    [outcomeMeta],
  );
  const outcomeTextStyle = useMemo(
    () => (outcomeMeta ? [styles.outcomeText, { color: outcomeMeta.color }] : null),
    [outcomeMeta],
  );
  const toggleExpanded = useCallback(() => setExpanded((prev) => !prev), []);
  const handleHoverIn = useCallback(() => setIsHovered(true), []);
  const handleHoverOut = useCallback(() => setIsHovered(false), []);
  const isCompact = useIsCompactFormFactor();
  // Hover never fires on native, so the chevron is the only expand affordance there and has to
  // be permanent. Same on a compact web viewport, which is touch-driven.
  const showChevron = isHovered || isNative || isCompact;
  const chevronStyle = useMemo(
    () => [styles.chevron, expanded && styles.chevronExpanded],
    [expanded],
  );

  const containerStyle = useMemo(
    () => [
      styles.container,
      disableOuterSpacing && styles.containerCompact,
      {
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
      },
    ],
    [disableOuterSpacing, theme.colors.surface1, theme.colors.border],
  );
  const titleStyle = useMemo(
    () => [styles.title, collapsible && styles.titleBold, { color: theme.colors.foreground }],
    [collapsible, theme.colors.foreground],
  );
  const descriptionStyle = useMemo(
    () => [styles.description, { color: theme.colors.foregroundMuted }],
    [theme.colors.foregroundMuted],
  );

  const headerContent = (
    <>
      {collapsible ? (
        <View style={styles.iconBadge}>
          {showChevron ? (
            <ThemedChevronRight size={12} style={chevronStyle} uniProps={foregroundIconColor} />
          ) : (
            <ThemedClipboardList size={12} uniProps={mutedIconColor} />
          )}
        </View>
      ) : null}
      <Text style={titleStyle} numberOfLines={collapsible ? 2 : undefined}>
        {resolvedTitle}
      </Text>
      {outcomeMeta ? (
        <View style={outcomePillStyle} testID={`${testID ?? "plan-card"}-outcome`}>
          <Text style={outcomeTextStyle}>{outcomeMeta.label}</Text>
        </View>
      ) : null}
    </>
  );

  return (
    <View testID={testID} style={containerStyle}>
      {collapsible ? (
        <Pressable
          style={styles.titleRow}
          onPress={toggleExpanded}
          onHoverIn={handleHoverIn}
          onHoverOut={handleHoverOut}
          accessibilityRole="button"
          testID={`${testID ?? "plan-card"}-toggle`}
        >
          {headerContent}
        </Pressable>
      ) : (
        <View style={styles.titleRow}>{headerContent}</View>
      )}
      {showBody ? (
        <>
          {description ? <Text style={descriptionStyle}>{description}</Text> : null}
          <Markdown style={markdownStyles} rules={markdownRules}>
            {bodyText}
          </Markdown>
        </>
      ) : null}
      {footer ? <View style={styles.footer}>{footer}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    marginVertical: theme.spacing[3],
    padding: theme.spacing[3],
    borderRadius: theme.spacing[2],
    borderWidth: 1,
    gap: theme.spacing[2],
  },
  containerCompact: {
    marginVertical: 0,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  title: {
    fontSize: theme.fontSize.base,
    lineHeight: 22,
    flexShrink: 1,
  },
  titleBold: {
    fontWeight: "600",
  },
  description: {
    fontSize: theme.fontSize.base,
    lineHeight: 20,
  },
  outcomePill: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    borderRadius: theme.spacing[2],
  },
  outcomeText: {
    fontSize: theme.fontSize.xs,
    lineHeight: 16,
    fontWeight: "600",
  },
  iconBadge: {
    width: 20,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  chevron: {
    flexShrink: 0,
    transform: [{ scale: 1.3 }],
  },
  chevronExpanded: {
    transform: [{ scale: 1.3 }, { rotate: "90deg" }],
  },
  footer: {
    gap: theme.spacing[2],
  },
}));

const LIST_ITEM_CONTENT_INNER = { flex: 1, flexShrink: 1, minWidth: 0 };
const PARAGRAPH_LAST_CHILD = { marginBottom: 0 };
