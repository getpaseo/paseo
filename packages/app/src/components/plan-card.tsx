import { useMemo, type ReactNode } from "react";
import { Text, View } from "react-native";
import Markdown from "react-native-markdown-display";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { createMarkdownStyles } from "@/styles/markdown-styles";
import { getMarkdownListMarker } from "@/utils/markdown-list";

function MarkdownInlineText({
  textKey,
  inheritedStyle,
  ruleStyle,
  children,
}: {
  textKey: string;
  inheritedStyle: any;
  ruleStyle: any;
  children: ReactNode;
}) {
  const style = useMemo(() => [inheritedStyle, ruleStyle], [inheritedStyle, ruleStyle]);
  return (
    <Text key={textKey} style={style}>
      {children}
    </Text>
  );
}

function MarkdownListItemContent({
  contentStyle,
  children,
}: {
  contentStyle: any;
  children: ReactNode;
}) {
  const style = useMemo(() => [contentStyle, LIST_ITEM_CONTENT_INNER], [contentStyle]);
  return <View style={style}>{children}</View>;
}

function MarkdownParagraph({
  textKey,
  paragraphStyle,
  isLastChild,
  children,
}: {
  textKey: string;
  paragraphStyle: any;
  isLastChild: boolean;
  children: ReactNode;
}) {
  const style = useMemo(
    () => [paragraphStyle, isLastChild ? PARAGRAPH_LAST_CHILD : false],
    [paragraphStyle, isLastChild],
  );
  return (
    <View key={textKey} style={style}>
      {children}
    </View>
  );
}

function createPlanMarkdownRules() {
  return {
    text: (
      node: any,
      _children: ReactNode[],
      _parent: any,
      styles: any,
      inheritedStyles: any = {},
    ) => (
      <MarkdownInlineText
        textKey={node.key}
        inheritedStyle={inheritedStyles}
        ruleStyle={styles.text}
      >
        {node.content}
      </MarkdownInlineText>
    ),
    textgroup: (
      node: any,
      children: ReactNode[],
      _parent: any,
      styles: any,
      inheritedStyles: any = {},
    ) => (
      <MarkdownInlineText
        textKey={node.key}
        inheritedStyle={inheritedStyles}
        ruleStyle={styles.textgroup}
      >
        {children}
      </MarkdownInlineText>
    ),
    code_block: (
      node: any,
      _children: ReactNode[],
      _parent: any,
      styles: any,
      inheritedStyles: any = {},
    ) => (
      <MarkdownInlineText
        textKey={node.key}
        inheritedStyle={inheritedStyles}
        ruleStyle={styles.code_block}
      >
        {node.content}
      </MarkdownInlineText>
    ),
    fence: (
      node: any,
      _children: ReactNode[],
      _parent: any,
      styles: any,
      inheritedStyles: any = {},
    ) => (
      <MarkdownInlineText
        textKey={node.key}
        inheritedStyle={inheritedStyles}
        ruleStyle={styles.fence}
      >
        {node.content}
      </MarkdownInlineText>
    ),
    code_inline: (
      node: any,
      _children: ReactNode[],
      _parent: any,
      styles: any,
      inheritedStyles: any = {},
    ) => (
      <MarkdownInlineText
        textKey={node.key}
        inheritedStyle={inheritedStyles}
        ruleStyle={styles.code_inline}
      >
        {node.content}
      </MarkdownInlineText>
    ),
    bullet_list: (node: any, children: ReactNode[], _parent: any, styles: any) => (
      <View key={node.key} style={styles.bullet_list}>
        {children}
      </View>
    ),
    ordered_list: (node: any, children: ReactNode[], _parent: any, styles: any) => (
      <View key={node.key} style={styles.ordered_list}>
        {children}
      </View>
    ),
    list_item: (node: any, children: ReactNode[], parent: any, styles: any) => {
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
    paragraph: (node: any, children: ReactNode[], parent: any, styles: any) => {
      const isLastChild = parent[0]?.children?.at(-1)?.key === node.key;
      return (
        <MarkdownParagraph
          textKey={node.key}
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
  title = "Plan",
  description,
  text,
  footer,
  disableOuterSpacing = false,
}: {
  title?: string;
  description?: string;
  text: string;
  footer?: ReactNode;
  disableOuterSpacing?: boolean;
}) {
  const { theme } = useUnistyles();
  const markdownStyles = createMarkdownStyles(theme);
  const markdownRules = createPlanMarkdownRules();

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
    () => [styles.title, { color: theme.colors.foreground }],
    [theme.colors.foreground],
  );
  const descriptionStyle = useMemo(
    () => [styles.description, { color: theme.colors.foregroundMuted }],
    [theme.colors.foregroundMuted],
  );

  return (
    <View style={containerStyle}>
      <Text style={titleStyle}>{title}</Text>
      {description ? <Text style={descriptionStyle}>{description}</Text> : null}
      <Markdown style={markdownStyles} rules={markdownRules}>
        {text}
      </Markdown>
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
  title: {
    fontSize: theme.fontSize.base,
    lineHeight: 22,
  },
  description: {
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
  },
  footer: {
    gap: theme.spacing[2],
  },
}));

const LIST_ITEM_CONTENT_INNER = { flex: 1, flexShrink: 1, minWidth: 0 };
const PARAGRAPH_LAST_CHILD = { marginBottom: 0 };
