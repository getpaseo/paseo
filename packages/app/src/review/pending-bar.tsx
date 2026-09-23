import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import type { GithubReviewSession } from "./github-session";

export function ChangesGithubPendingBar({ session }: { session: GithubReviewSession }) {
  if (session.pendingCount === 0 || !session.canWrite) {
    return null;
  }
  return (
    <GithubPendingReviewBar
      count={session.pendingCount}
      onSubmit={session.submit}
      onCancel={session.cancelPending}
    />
  );
}

export function GithubPendingReviewBar({
  count,
  onSubmit,
  onCancel,
}: {
  count: number;
  onSubmit: (event: "comment" | "approve" | "request_changes") => Promise<void>;
  onCancel: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const handleCancel = useCallback(() => {
    void onCancel();
  }, [onCancel]);
  const handleComment = useCallback(() => {
    void onSubmit("comment");
  }, [onSubmit]);
  const handleApprove = useCallback(() => {
    void onSubmit("approve");
  }, [onSubmit]);
  const handleRequestChanges = useCallback(() => {
    void onSubmit("request_changes");
  }, [onSubmit]);
  return (
    <View style={styles.bar} testID="github-pending-review-bar">
      <Text style={styles.label}>{t("review.github.pending", { count })}</Text>
      <View style={styles.actions}>
        <Button
          size="xs"
          variant="ghost"
          testID="github-pending-review-cancel"
          onPress={handleCancel}
        >
          {t("review.github.cancelPending")}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          testID="github-pending-review-comment"
          onPress={handleComment}
        >
          {t("review.github.submitComment")}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          testID="github-pending-review-approve"
          onPress={handleApprove}
        >
          {t("review.github.submitApprove")}
        </Button>
        <Button
          size="xs"
          variant="default"
          testID="github-pending-review-request-changes"
          onPress={handleRequestChanges}
        >
          {t("review.github.submitRequestChanges")}
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
  },
  label: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexWrap: "wrap",
  },
}));
