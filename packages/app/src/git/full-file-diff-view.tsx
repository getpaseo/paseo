import { useEffect, useMemo, useRef } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { highlightCode } from "@getpaseo/highlight";
import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useLiveFile } from "@/file-pane/live-file/hook";
import { DiffDocument, type WorkingDiffMode } from "@/git/diff-document";
import {
  buildFullFileDiff,
  diffFileSignature,
  type FullFileDiffResult,
  type FullFileDiffUnavailableReason,
} from "@/git/full-file-diff";
import { usePublishFullFileReviewContext } from "@/git/full-file-review-context";
import { useCheckoutDiffQuery } from "@/git/use-diff-query";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";

// Past these sizes the whole-file document costs more than it helps: highlighting runs
// synchronously on the UI thread, and every line becomes a layout row.
const MAX_FULL_FILE_BYTES = 5 * 1024 * 1024;
const MAX_HIGHLIGHTED_BYTES = 512 * 1024;

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const foregroundMutedIconColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

type NoticeReason = Exclude<FullFileDiffUnavailableReason, "binary"> | "uncommitted";

interface FullFileDiffViewProps {
  serverId: string;
  cwd: string;
  file: ParsedDiffFile;
  diffMode: "uncommitted" | "base";
  isDirty: boolean;
  displayPreferences: {
    layout: "unified" | "split";
    wrapLines: boolean;
    codeFontSize: number;
    monoFontFamily: string;
  };
  mode: WorkingDiffMode;
  collapseState: { paths: readonly string[]; onChange: (paths: string[]) => void };
  contentInsetBottom?: number;
  onSelectUncommitted: () => void;
}

/**
 * One changed file with every line, changes highlighted in place. Unchanged lines come
 * from the working tree, so the committed comparison can only expand files that carry
 * no uncommitted edits; the rest fall back to the file's hunks with a notice.
 */
export function FullFileDiffView(props: FullFileDiffViewProps) {
  const { t } = useTranslation();
  const { file, cwd } = props;
  const { result, expanded } = useFullFileExpansion({ serverId: props.serverId, cwd, file });
  const uncommitted = useUncommittedEdits({
    serverId: props.serverId,
    cwd,
    path: file.path,
    // The committed comparison ends at HEAD; a working tree with edits to this file
    // cannot stand in for it.
    enabled: props.diffMode === "base" && props.isDirty,
  });

  const publishReviewContext = usePublishFullFileReviewContext();
  useEffect(() => {
    if (result?.kind === "ready" && !uncommitted.hasEdits) {
      publishReviewContext({ cwd, source: file, fullFile: result.file });
    }
  }, [cwd, file, publishReviewContext, result, uncommitted.hasEdits]);

  const hasUncommittedEdits = uncommitted.hasEdits;
  if (uncommitted.pending || (result === null && !hasUncommittedEdits)) {
    return (
      <View style={styles.loading} testID="full-file-diff-loading">
        <ThemedLoadingSpinner size="large" uniProps={foregroundMutedIconColorMapping} />
      </View>
    );
  }

  const notice = resolveNotice({ hasUncommittedEdits, result, expanded });
  const documentFile = notice ? file : (expanded ?? file);
  return (
    <View style={styles.container} testID="full-file-diff">
      {notice ? (
        <View style={styles.notice} testID="full-file-diff-notice">
          <Text style={styles.noticeText}>{t(NOTICE_KEYS[notice])}</Text>
          {notice === "uncommitted" ? (
            <Button variant="ghost" size="xs" onPress={props.onSelectUncommitted}>
              {t("workspace.git.diff.seeUncommittedChanges")}
            </Button>
          ) : null}
        </View>
      ) : null}
      <DiffDocument
        key={file.path}
        files={[documentFile]}
        contentInsetBottom={props.contentInsetBottom}
        collapseState={props.collapseState}
        displayPreferences={props.displayPreferences}
        mode={props.mode}
        minimap={!notice}
        revealFirstChange={!notice}
      />
    </View>
  );
}

function useFullFileExpansion(input: { serverId: string; cwd: string; file: ParsedDiffFile }): {
  result: FullFileDiffResult | null;
  expanded: ParsedDiffFile | null;
} {
  const { serverId, cwd, file } = input;
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  // COMPAT(workspaceFileEditing): added in v0.2.0, remove after 2027-01-18 once daemon floor >= v0.2.0.
  const supportsFileSubscription = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.workspaceFileEditing === true,
  );
  const readsContent = !file.isDeleted && (file.status ?? "ok") === "ok";
  const liveFile = useLiveFile({
    client,
    cwd,
    path: readsContent ? file.path : null,
    enabled: readsContent,
    liveUpdates: supportsFileSubscription,
  });

  // Without a file subscription, the diff update is the signal that the file moved on.
  const signature = diffFileSignature(file);
  const refreshFile = liveFile.refresh;
  const lastSignatureRef = useRef(signature);
  useEffect(() => {
    if (lastSignatureRef.current === signature) return;
    lastSignatureRef.current = signature;
    if (!supportsFileSubscription && readsContent) refreshFile();
  }, [readsContent, refreshFile, signature, supportsFileSubscription]);

  const content = useMemo(() => {
    const read = liveFile.file;
    if (!read || read.path !== file.path) return null;
    if (read.kind !== "text" || read.bytes.byteLength > MAX_FULL_FILE_BYTES) return undefined;
    return new TextDecoder().decode(read.bytes);
  }, [file.path, liveFile.file]);
  const tokens = useMemo(
    () =>
      typeof content === "string" && content.length <= MAX_HIGHLIGHTED_BYTES
        ? highlightCode(content, file.path)
        : null,
    [content, file.path],
  );

  const result = useMemo<FullFileDiffResult | null>(() => {
    if (!readsContent) return buildFullFileDiff({ file, newContent: null });
    if (content === undefined) return { kind: "unavailable", reason: "too_large" };
    if (content === null) {
      return liveFile.error ? { kind: "unavailable", reason: "missing" } : null;
    }
    return buildFullFileDiff({ file, newContent: content, newTokens: tokens });
  }, [content, file, liveFile.error, readsContent, tokens]);

  // A diff push and the matching file read land separately. Hold the last aligned
  // expansion of this file across that gap rather than flashing the fallback.
  const lastReadyRef = useRef<{ path: string; file: ParsedDiffFile } | null>(null);
  if (result?.kind === "ready") {
    lastReadyRef.current = { path: file.path, file: result.file };
    return { result, expanded: result.file };
  }
  const holdsLastReady =
    result?.kind === "unavailable" &&
    result.reason === "out_of_sync" &&
    lastReadyRef.current?.path === file.path;
  return { result, expanded: holdsLastReady ? (lastReadyRef.current?.file ?? null) : null };
}

function useUncommittedEdits(input: {
  serverId: string;
  cwd: string;
  path: string;
  enabled: boolean;
}): { pending: boolean; hasEdits: boolean } {
  const uncommitted = useCheckoutDiffQuery({
    serverId: input.serverId,
    cwd: input.cwd,
    mode: "uncommitted",
    enabled: input.enabled,
  });
  if (!input.enabled) return { pending: false, hasEdits: false };
  return {
    pending: uncommitted.isLoading,
    hasEdits: uncommitted.files.some((entry) => entry.path === input.path),
  };
}

const NOTICE_KEYS = {
  out_of_sync: "workspace.git.diff.fullFileUnavailable.outOfSync",
  missing: "workspace.git.diff.fullFileUnavailable.missing",
  too_large: "workspace.git.diff.fullFileUnavailable.tooLarge",
  uncommitted: "workspace.git.diff.fullFileUnavailable.uncommitted",
} as const satisfies Record<NoticeReason, string>;

function resolveNotice(input: {
  hasUncommittedEdits: boolean;
  result: FullFileDiffResult | null;
  expanded: ParsedDiffFile | null;
}): NoticeReason | null {
  if (input.hasUncommittedEdits) return "uncommitted";
  if (input.expanded || input.result?.kind !== "unavailable") return null;
  // Binary files already render their own status row.
  return input.result.reason === "binary" ? null : input.result.reason;
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
  },
  loading: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingTop: theme.spacing[16],
  },
  notice: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  noticeText: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));
