import type { ReactNode } from "react";
import { Text, View } from "react-native";
import Markdown from "react-native-markdown-display";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { createMarkdownStyles } from "@/styles/markdown-styles";
import { getMarkdownListMarker } from "@/utils/markdown-list";

function createPlanMarkdownRules() {
  return {
    text: (
      node: any,
      _children: ReactNode[],
      _parent: any,
      styles: any,
      inheritedStyles: any = {},
    ) => (
      <Text key={node.key} style={[inheritedStyles, styles.text]}>
        {node.content}
      </Text>
    ),
    textgroup: (
      node: any,
      children: ReactNode[],
      _parent: any,
      styles: any,
      inheritedStyles: any = {},
    ) => (
      <Text key={node.key} style={[inheritedStyles, styles.textgroup]}>
        {children}
      </Text>
    ),
    code_block: (
      node: any,
      _children: ReactNode[],
      _parent: any,
      styles: any,
      inheritedStyles: any = {},
    ) => (
      <Text key={node.key} style={[inheritedStyles, styles.code_block]}>
        {node.content}
      </Text>
    ),
    fence: (
      node: any,
      _children: ReactNode[],
      _parent: any,
      styles: any,
      inheritedStyles: any = {},
    ) => (
      <Text key={node.key} style={[inheritedStyles, styles.fence]}>
        {node.content}
      </Text>
    ),
    code_inline: (
      node: any,
      _children: ReactNode[],
      _parent: any,
      styles: any,
      inheritedStyles: any = {},
    ) => (
      <Text key={node.key} style={[inheritedStyles, styles.code_inline]}>
        {node.content}
      </Text>
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
          <View style={[contentStyle, { flex: 1, flexShrink: 1, minWidth: 0 }]}>{children}</View>
        </View>
      );
    },
    paragraph: (node: any, children: ReactNode[], parent: any, styles: any) => {
      const isLastChild = parent[0]?.children?.at(-1)?.key === node.key;
      return (
        <View key={node.key} style={[styles.paragraph, isLastChild && { marginBottom: 0 }]}>
          {children}
        </View>
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

  return (
    <View
      style={[
        styles.container,
        disableOuterSpacing && styles.containerCompact,
        {
          backgroundColor: theme.colors.surface1,
          borderColor: theme.colors.border,
        },
      ]}
    >
      <Text style={[styles.title, { color: theme.colors.foreground }]}>{title}</Text>
      {description ? (
        <Text style={[styles.description, { color: theme.colors.foregroundMuted }]}>
          {description}
        </Text>
      ) : null}
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
