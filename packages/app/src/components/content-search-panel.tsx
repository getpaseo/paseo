import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { ChevronRight, Search, X } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { Theme } from "@/styles/theme";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { splitHighlightSegments } from "@/components/content-search-highlight";

const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedSearch = withUnistyles(Search);
const ThemedX = withUnistyles(X);

export interface ContentSearchFileResult {
  relPath: string;
  matches: Array<{ line: number; text: string }>;
}

const DEBOUNCE_MS = 300;
const MIN_QUERY_LENGTH = 2;
/** Max result files rendered — keeps the ScrollView cheap on huge matches. */
const MAX_RENDERED_FILES = 50;
const MAX_MATCHES_PER_FILE_RENDERED = 20;

// Module-level so Pressable style callbacks stay referentially stable.
const matchRowStyle = { flexDirection: "row", alignItems: "center", gap: 6 } as const;

interface ContentSearchPanelProps {
  serverId: string;
  workspaceRoot: string;
  onClose: () => void;
  onOpenFile: (relPath: string) => void;
}

/**
 * VSCode-style "search in files" panel for the workspace file explorer:
 * debounced fixed-string search, results grouped in one collapsible accordion
 * per file, tap a match row to open the file. Pure display — the search itself
 * runs on the daemon (`fs.content_search` RPC).
 */
export function ContentSearchPanel({
  serverId,
  workspaceRoot,
  onClose,
  onOpenFile,
}: ContentSearchPanelProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<ContentSearchFileResult[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const seqRef = useRef(0);

  // Debounced search execution — a sequence number drops stale responses.
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      seqRef.current += 1;
      setLoading(false);
      setError(null);
      setFiles([]);
      setTruncated(false);
      return;
    }
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    const timer = setTimeout(() => {
      const client = getHostRuntimeStore().getClient(serverId);
      if (!client) {
        if (seq === seqRef.current) {
          setLoading(false);
          setError("Client unavailable");
        }
        return;
      }
      void client
        .searchFileContents(workspaceRoot, trimmed)
        .then((payload) => {
          if (seq !== seqRef.current) return null;
          setLoading(false);
          if (payload.error) {
            setError(payload.error);
            setFiles([]);
            return null;
          }
          setFiles(payload.files);
          setTruncated(payload.truncated);
          // Auto-expand the first file's accordion, VSCode-style.
          setExpandedFiles(
            payload.files.length > 0 ? new Set([payload.files[0].relPath]) : new Set(),
          );
          return null;
        })
        .catch((cause: unknown) => {
          if (seq !== seqRef.current) return;
          setLoading(false);
          setError(cause instanceof Error ? cause.message : String(cause));
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, serverId, workspaceRoot]);

  const toggleFile = useCallback((relPath: string) => {
    setExpandedFiles((current) => {
      const next = new Set(current);
      if (next.has(relPath)) {
        next.delete(relPath);
      } else {
        next.add(relPath);
      }
      return next;
    });
  }, []);

  const renderedFiles = useMemo(() => files.slice(0, MAX_RENDERED_FILES), [files]);

  const trimmedQuery = query.trim();

  const searchIconProps = useCallback(
    (theme: Theme) => ({ color: theme.colors.foregroundMuted }),
    [],
  );
  const closeIconHoverProps = useCallback(
    (hovered: boolean) => (theme: Theme) => ({
      color: hovered ? theme.colors.foreground : theme.colors.foregroundMuted,
    }),
    [],
  );
  const accordionIconProps = useCallback(
    (hovered: boolean) => (theme: Theme) => ({
      color: hovered ? theme.colors.foreground : theme.colors.foregroundMuted,
    }),
    [],
  );
  const handleMatchOpen = useCallback((relPath: string) => onOpenFile(relPath), [onOpenFile]);

  return (
    <View style={styles.container}>
      <View style={styles.inputRow}>
        <ThemedSearch size={13} uniProps={searchIconProps} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={t("workspace.fileExplorer.search.placeholder")}
          autoFocus
          style={styles.input}
          testID="content-search-input"
        />
        {loading ? <Text style={styles.loadingText}>…</Text> : null}
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={t("workspace.fileExplorer.search.close")}
          hitSlop={8}
        >
          {({ hovered }) => <ThemedX size={13} uniProps={closeIconHoverProps(hovered)} />}
        </Pressable>
      </View>
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
      {!error && trimmedQuery.length >= MIN_QUERY_LENGTH && !loading && files.length === 0 ? (
        <Text style={styles.emptyText}>{t("workspace.fileExplorer.search.noResults")}</Text>
      ) : null}
      {renderedFiles.map((file) => (
        <FileResultAccordion
          key={file.relPath}
          file={file}
          query={trimmedQuery}
          expanded={expandedFiles.has(file.relPath)}
          onToggle={toggleFile}
          onOpenFile={handleMatchOpen}
          iconProps={accordionIconProps}
        />
      ))}
      {truncated ? (
        <Text style={styles.truncatedText}>{t("workspace.fileExplorer.search.truncated")}</Text>
      ) : null}
    </View>
  );
}

function FileResultRow({
  file,
  match,
  query,
  onOpen,
}: {
  file: ContentSearchFileResult;
  match: { line: number; text: string };
  query: string;
  onOpen: (relPath: string) => void;
}) {
  const handleOpen = useCallback(() => onOpen(file.relPath), [file.relPath, onOpen]);
  return (
    <Pressable
      onPress={handleOpen}
      accessibilityRole="button"
      accessibilityLabel={`${file.relPath}:${match.line}`}
      style={matchRowStyle}
      testID={`content-search-match-${file.relPath}-${match.line}`}
    >
      <Text style={styles.lineNumber}>{match.line}</Text>
      <Text numberOfLines={1} style={styles.matchText}>
        {splitHighlightSegments(match.text, query).map((segment) => (
          <Text key={`${match.line}-${segment.hit ? "h" : "p"}-${segment.text}`}>
            {segment.hit ? <Text style={styles.matchHighlight}>{segment.text}</Text> : segment.text}
          </Text>
        ))}
      </Text>
    </Pressable>
  );
}

function FileResultAccordion({
  file,
  query,
  expanded,
  onToggle,
  onOpenFile,
  iconProps,
}: {
  file: ContentSearchFileResult;
  query: string;
  expanded: boolean;
  onToggle: (relPath: string) => void;
  onOpenFile: (relPath: string) => void;
  iconProps: (hovered: boolean) => (theme: Theme) => { color: string };
}) {
  const matches = file.matches.slice(0, MAX_MATCHES_PER_FILE_RENDERED);
  const handleToggle = useCallback(() => onToggle(file.relPath), [file.relPath, onToggle]);
  return (
    <View>
      <Pressable
        onPress={handleToggle}
        accessibilityRole="button"
        accessibilityLabel={file.relPath}
        style={matchRowStyle}
        testID={`content-search-file-${file.relPath}`}
      >
        {({ hovered }) => (
          <>
            <ThemedChevronRight
              size={12}
              uniProps={iconProps(hovered)}
              style={expanded ? styles.chevronExpanded : undefined}
            />
            <Text numberOfLines={1} style={styles.filePath}>
              {file.relPath}
            </Text>
            <Text style={styles.matchCount}>{file.matches.length}</Text>
          </>
        )}
      </Pressable>
      {expanded
        ? matches.map((match) => (
            <FileResultRow
              key={`${file.relPath}:${match.line}`}
              file={file}
              match={match}
              query={query}
              onOpen={onOpenFile}
            />
          ))
        : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    gap: 2,
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 4,
  },
  input: {
    flex: 1,
    minHeight: 24,
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface2,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: 6,
    fontSize: 12,
    paddingVertical: 2,
  },
  loadingText: {
    color: theme.colors.foregroundMuted,
    fontSize: 11,
  },
  errorText: {
    color: theme.colors.statusDanger,
    fontSize: 11,
    paddingHorizontal: 4,
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: 11,
    paddingHorizontal: 4,
  },
  truncatedText: {
    color: theme.colors.foregroundMuted,
    fontSize: 10,
    paddingHorizontal: 4,
  },
  matchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 3,
    paddingHorizontal: 4,
    borderRadius: 4,
  },
  rowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  chevronExpanded: {
    transform: [{ rotate: "90deg" }],
  },
  filePath: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: 11,
    fontFamily: theme.fontFamily.mono,
  },
  matchCount: {
    color: theme.colors.foregroundMuted,
    fontSize: 10,
    fontFamily: theme.fontFamily.mono,
  },
  lineNumber: {
    minWidth: 28,
    textAlign: "right",
    color: theme.colors.foregroundMuted,
    fontSize: 10,
    fontFamily: theme.fontFamily.mono,
  },
  matchText: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: 11,
    fontFamily: theme.fontFamily.mono,
  },
  matchHighlight: {
    backgroundColor: theme.colors.accent,
    color: theme.colors.accentForeground,
  },
}));
