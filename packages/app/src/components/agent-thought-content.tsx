import { memo, useMemo } from "react";
import { Text, View } from "react-native";
import Markdown from "react-native-markdown-display";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { createCompactMarkdownStyles } from "@/styles/markdown-styles";

export const AgentThoughtContent = memo(function AgentThoughtContent({
  message,
}: {
  message: string;
}) {
  const { theme } = useUnistyles();
  const markdownContent = useMemo(() => message?.trim() ?? "", [message]);
  const markdownStyles = useMemo(
    () => createCompactMarkdownStyles(theme),
    [theme]
  );

  const markdownRules = useMemo(() => {
    return {
      text: (node: any, _children: any[], _parent: any, styles: any, inheritedStyles: any = {}) => (
        <Text key={node.key} style={[inheritedStyles, styles.text]}>
          {node.content}
        </Text>
      ),
      textgroup: (node: any, children: any[], _parent: any, styles: any, inheritedStyles: any = {}) => (
        <Text key={node.key} style={[inheritedStyles, styles.textgroup]}>
          {children}
        </Text>
      ),
      code_block: (node: any, _children: any[], _parent: any, styles: any, inheritedStyles: any = {}) => (
        <Text key={node.key} style={[inheritedStyles, styles.code_block]}>
          {node.content}
        </Text>
      ),
      fence: (node: any, _children: any[], _parent: any, styles: any, inheritedStyles: any = {}) => (
        <Text key={node.key} style={[inheritedStyles, styles.fence]}>
          {node.content}
        </Text>
      ),
      code_inline: (node: any, _children: any[], _parent: any, styles: any, inheritedStyles: any = {}) => (
        <Text key={node.key} style={[inheritedStyles, styles.code_inline]}>
          {node.content}
        </Text>
      ),
      bullet_list: (node: any, children: any[], _parent: any, styles: any) => (
        <View key={node.key} style={styles.bullet_list}>
          {children}
        </View>
      ),
      ordered_list: (node: any, children: any[], _parent: any, styles: any) => (
        <View key={node.key} style={styles.ordered_list}>
          {children}
        </View>
      ),
      list_item: (node: any, children: any[], parent: any, styles: any) => {
        const isOrdered = parent?.type === "ordered_list";
        const index = parent?.children?.indexOf(node) ?? 0;
        const bullet = isOrdered ? `${index + 1}.` : "•";
        const iconStyle = isOrdered ? styles.ordered_list_icon : styles.bullet_list_icon;
        const contentStyle = isOrdered
          ? styles.ordered_list_content
          : styles.bullet_list_content;

        return (
          <View key={node.key} style={styles.list_item}>
            <Text style={iconStyle}>{bullet}</Text>
            <View style={[contentStyle, { flex: 1, flexShrink: 1, minWidth: 0 }]}>
              {children}
            </View>
          </View>
        );
      },
    };
  }, []);

  if (!markdownContent) {
    return <Text style={styles.emptyText}>No captured thinking</Text>;
  }

  return (
    <Markdown style={markdownStyles} rules={markdownRules}>
      {markdownContent}
    </Markdown>
  );
});

const styles = StyleSheet.create((theme) => ({
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontStyle: "italic" as const,
  },
}));

