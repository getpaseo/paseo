import {
  View,
  Text,
  ScrollView,
  Pressable,
  Modal,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useEffect } from "react";
import { StyleSheet } from "react-native-unistyles";
import { Fonts } from "@/constants/theme";

export interface Artifact {
  id: string;
  type: "markdown" | "diff" | "image" | "code";
  title: string;
  content: string;
  isBase64: boolean;
}

interface ArtifactDrawerProps {
  artifact: Artifact | null;
  onClose: () => void;
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
    flexDirection: "column",
  },
  header: {
    paddingBottom: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  titleContainer: {
    flex: 1,
    marginRight: theme.spacing[4],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize["2xl"],
    fontWeight: theme.fontWeight.bold,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  badge: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
  },
  badgeMarkdown: {
    backgroundColor: theme.colors.primary,
  },
  badgeDiff: {
    backgroundColor: theme.colors.palette.purple[600],
  },
  badgeImage: {
    backgroundColor: theme.colors.palette.green[600],
  },
  badgeCode: {
    backgroundColor: theme.colors.palette.orange[600],
  },
  badgeText: {
    color: theme.colors.primaryForeground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
  },
  closeButton: {
    backgroundColor: theme.colors.surface2,
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  closeButtonText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize["2xl"],
    fontWeight: theme.fontWeight.bold,
  },
  contentScroll: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  contentScrollContainer: {
    padding: theme.spacing[4],
    flexGrow: 1,
  },
  imagePlaceholder: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  imagePlaceholderText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  imagePlaceholderSubtext: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    marginTop: theme.spacing[2],
  },
  codeContainer: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[4],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  codeText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontFamily: Fonts.mono,
  },
  metadataContainer: {
    backgroundColor: theme.colors.surface2,
    padding: theme.spacing[3],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    marginTop: theme.spacing[2],
  },
  metadataTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    marginBottom: theme.spacing[2],
  },
  metadataRow: {
    flexDirection: "row",
    marginBottom: theme.spacing[1],
  },
  metadataLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    width: 80,
  },
  metadataValue: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    flex: 1,
    fontFamily: Fonts.mono,
  },
}));

export function ArtifactDrawer({ artifact, onClose }: ArtifactDrawerProps) {
  useEffect(() => {
    if (!artifact) return;
    console.log(
      "[ArtifactDrawer] Showing artifact:",
      artifact.id,
      artifact.type,
      artifact.title
    );
  }, [artifact]);

  if (!artifact) {
    return null;
  }

  // Decode content if base64
  const content = artifact.isBase64 ? atob(artifact.content) : artifact.content;

  // Type badge style mapping
  const typeBadgeStyles = {
    markdown: styles.badgeMarkdown,
    diff: styles.badgeDiff,
    image: styles.badgeImage,
    code: styles.badgeCode,
  };

  return (
    <Modal
      visible={!!artifact}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView edges={["top", "bottom"]} style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerRow}>
            <View style={styles.titleContainer}>
              <Text style={styles.title} numberOfLines={2}>
                {artifact.title}
              </Text>
            </View>
            <View style={styles.headerActions}>
              <View
                style={[
                  styles.badge,
                  typeBadgeStyles[artifact.type],
                ]}
              >
                <Text style={styles.badgeText}>
                  {artifact.type.toUpperCase()}
                </Text>
              </View>
              <Pressable onPress={onClose} style={styles.closeButton}>
                <Text style={styles.closeButtonText}>×</Text>
              </Pressable>
            </View>
          </View>
        </View>
        {/* Content */}
        <ScrollView
          style={styles.contentScroll}
          contentContainerStyle={styles.contentScrollContainer}
        >
          {artifact.type === "image" ? (
            <View style={styles.imagePlaceholder}>
              <Text style={styles.imagePlaceholderText}>
                Image viewing not yet implemented
              </Text>
              <Text style={styles.imagePlaceholderSubtext}>
                Base64 image data received
              </Text>
            </View>
          ) : (
            <View style={styles.codeContainer}>
              <ScrollView horizontal showsHorizontalScrollIndicator={true}>
                <Text style={styles.codeText}>{content}</Text>
              </ScrollView>
            </View>
          )}
        </ScrollView>

        {/* Metadata - Fixed at bottom */}
        <View style={styles.metadataContainer}>
          <Text style={styles.metadataTitle}>METADATA</Text>
          <View>
            <View style={styles.metadataRow}>
              <Text style={styles.metadataLabel}>ID:</Text>
              <Text style={styles.metadataValue}>{artifact.id}</Text>
            </View>
            <View style={styles.metadataRow}>
              <Text style={styles.metadataLabel}>Type:</Text>
              <Text style={styles.metadataValue}>{artifact.type}</Text>
            </View>
            <View style={styles.metadataRow}>
              <Text style={styles.metadataLabel}>Encoding:</Text>
              <Text style={styles.metadataValue}>
                {artifact.isBase64 ? "Base64" : "Plain text"}
              </Text>
            </View>
            <View style={styles.metadataRow}>
              <Text style={styles.metadataLabel}>Size:</Text>
              <Text style={styles.metadataValue}>
                {content.length.toLocaleString()} characters
              </Text>
            </View>
          </View>
        </View>
      </SafeAreaView>
    </Modal>
  );
}
