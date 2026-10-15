import { useCallback, useMemo, useState, type ReactNode } from "react";
import {
  Pressable,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { type ASTNode } from "react-native-markdown-display";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { ChevronRight } from "lucide-react-native";
import { isWeb } from "@/constants/platform";
import type { Theme } from "@/styles/theme";
import { getMarkdownListMarker } from "@/utils/markdown-list";
import { createMarkdownParser } from "@/utils/markdown-parser";

// Without this prop react-native-markdown-display builds its own parser with
// `typographer: true`, which would render a plan's literal `(c)` as ©. Its
// default also leaves linkify off, so this one keeps bare URLs as plain text.
const planMarkdownParser = createMarkdownParser({ linkify: false });

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

export type PlanOutcome = "pending" | "approved" | "rejected" | "canceled";

export interface PlanCardProps {
  title?: string;
  description?: string;
  text: string;
  outcome?: PlanOutcome;
  footer?: ReactNode;
  disableOuterSpacing?: boolean;
  testID?: string;
}

const ThemedChevron = withUnistyles(ChevronRight);
const chevronColor = (theme: Theme) => ({ color: theme.colors.planCard.headerForeground });
const markdownRules = createPlanMarkdownRules();

export function PlanCard(props: PlanCardProps) {
  const containerStyle = useMemo(
    () => [styles.container, props.disableOuterSpacing && styles.containerCompact],
    [props.disableOuterSpacing],
  );
  // Reset presentation on resolution without aborting actions still waiting for their result.
  return (
    <View testID={props.testID} style={containerStyle}>
      <PlanCardContent key={props.outcome ?? "proposed"} {...props} />
      {props.footer ? <View style={styles.footer}>{props.footer}</View> : null}
    </View>
  );
}

function PlanCardContent({ title, description, text, outcome }: PlanCardProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(outcome !== "rejected" && outcome !== "canceled");
  const labels = {
    pending: title ?? t("agentStream.permission.plan"),
    rejected: t("agentStream.permission.rejectedPlan"),
    approved: t("agentStream.permission.approvedPlan"),
    canceled: t("agentStream.permission.canceledPlan"),
  };
  const resolvedTitle = labels[outcome ?? "pending"];
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  const webExpandedState = useMemo(
    () => (isWeb ? ({ "aria-expanded": expanded } as const) : null),
    [expanded],
  );
  const toggleExpanded = useCallback(() => setExpanded((value) => !value), []);
  const chevronStyle = useMemo(
    () => [styles.chevron, expanded && styles.chevronExpanded],
    [expanded],
  );

  return (
    <>
      <Pressable
        {...webExpandedState}
        accessibilityRole="button"
        accessibilityLabel={resolvedTitle}
        accessibilityState={accessibilityState}
        onPress={toggleExpanded}
        style={styles.header}
      >
        <View style={chevronStyle}>
          <ThemedChevron size={16} uniProps={chevronColor} />
        </View>
        <Text style={styles.title}>{resolvedTitle}</Text>
      </Pressable>
      {expanded ? (
        <View style={styles.body}>
          {description ? <Text style={styles.description}>{description}</Text> : null}
          <MarkdownRenderer text={text} rules={markdownRules} markdownit={planMarkdownParser} />
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    marginVertical: theme.spacing[3],
    padding: theme.spacing[3],
    borderRadius: theme.spacing[2],
    borderWidth: 1,
    backgroundColor: theme.colors.planCard.background,
    borderColor: theme.colors.planCard.border,
    overflow: "hidden",
    gap: theme.spacing[2],
  },
  containerCompact: {
    marginVertical: 0,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 36,
    marginTop: -theme.spacing[3],
    marginHorizontal: -theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    backgroundColor: theme.colors.planCard.header,
  },
  chevron: {},
  chevronExpanded: { transform: [{ rotate: "90deg" }] },
  body: { gap: theme.spacing[2] },
  title: {
    color: theme.colors.planCard.headerForeground,
    flexShrink: 1,
    fontSize: theme.fontSize.base,
    lineHeight: 22,
  },
  description: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    lineHeight: 20,
  },
  footer: {
    gap: theme.spacing[2],
    marginHorizontal: -theme.spacing[3],
    marginBottom: -theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    backgroundColor: theme.colors.planCard.footer,
  },
}));

const LIST_ITEM_CONTENT_INNER = { flex: 1, flexShrink: 1, minWidth: 0 };
const PARAGRAPH_LAST_CHILD = { marginBottom: 0 };
