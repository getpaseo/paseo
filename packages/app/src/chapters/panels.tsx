import { ChaptersOutline, ChapterRow, ChapterStatus } from "./outline";
import { chapterStyles as styles } from "./styles";
import React, { useCallback, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { BookOpen } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import invariant from "tiny-invariant";
import { selectChapterFiles } from "@getpaseo/protocol/chapters";
import type { ChapterOutline, ChapterStory } from "@getpaseo/protocol/messages";
import { Button } from "@/components/ui/button";
import { usePaneContext } from "@/panels/pane-context";
import { definePanel, type PanelPresentation } from "@/panels/panel-registry";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { DiffDocument } from "@/git/diff-document";
import { DiffLayoutToggle } from "@/git/diff-pane";
import { useDiffPanelPreferences } from "@/panels/diff-panel";
import {
  buildReviewDraftKey,
  useInlineReviewController,
  useReviewAttachmentSnapshot,
} from "@/review";
import { usePublishWorkingDiffAttachment } from "@/git/use-working-diff";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useChapters, type ChaptersScope } from "./use-chapters";

const ThemedBook = withUnistyles(BookOpen);
type Selection = Extract<WorkspaceTabTarget, { kind: "chapter" }>;
type Chapter = ChapterOutline["chapters"][number];

export function ChaptersContent({
  openTab,
  ...scope
}: ChaptersScope & { openTab: (target: Selection) => void }) {
  const chapters = useChapters(scope);
  return <ChaptersOutline chapters={chapters} openTab={openTab} />;
}

function ChaptersPanel() {
  const { serverId, workspaceId, openTab } = usePaneContext();
  const cwd = useWorkspaceDirectory(serverId, workspaceId) ?? "";
  return (
    <ChaptersContent serverId={serverId} workspaceId={workspaceId} cwd={cwd} openTab={openTab} />
  );
}

function ChapterPanel() {
  const { serverId, workspaceId, target, retargetCurrentTab } = usePaneContext();
  invariant(target.kind === "chapter", "Expected chapter target");
  const cwd = useWorkspaceDirectory(serverId, workspaceId) ?? "";
  const scope = useMemo(() => ({ serverId, workspaceId, cwd }), [serverId, workspaceId, cwd]);
  const chapters = useChapters(scope);
  const { t } = useTranslation();
  const story = chapters.story;
  const chapter = story?.outline.chapters.find((item) => item.id === target.selectionId);
  const category = target.category
    ? story?.outline.categories.find((item) => item.id === target.selectionId)
    : undefined;
  return (
    <View style={styles.container} testID="chapter-viewer">
      <ChapterStatus chapters={chapters} />
      {story && category ? (
        <ScrollView contentContainerStyle={styles.introduction}>
          <Text style={styles.heading}>{category.title}</Text>
          <Text selectable style={styles.description}>
            {category.description}
          </Text>
          {story.outline.chapters
            .filter((item) => category.chapterIds.includes(item.id))
            .map((item) => (
              <ChapterRow key={item.id} chapter={item} story={story} openTab={retargetCurrentTab} />
            ))}
        </ScrollView>
      ) : null}
      {story && chapter && !target.category ? (
        <ChapterDiff
          key={`${story.fingerprint}:${chapter.id}`}
          story={story}
          chapter={chapter}
          scope={scope}
          stale={chapters.stale || !chapters.connected || Boolean(chapters.error)}
          openTab={retargetCurrentTab}
        />
      ) : null}
      {story && !chapter && !category ? (
        <Text style={styles.message}>{t("chapters.select")}</Text>
      ) : null}
    </View>
  );
}

function ChapterDiff({
  story,
  chapter,
  scope,
  stale,
  openTab,
}: {
  story: ChapterStory;
  chapter: Chapter;
  scope: ChaptersScope;
  stale: boolean;
  openTab: (target: Selection) => void;
}) {
  const { t } = useTranslation();
  const { displayPreferences, canUseSplitLayout, toggleLayout, isCompact } =
    useDiffPanelPreferences();
  const files = useMemo(() => selectChapterFiles(story.files, chapter.sections), [story, chapter]);
  const key = buildReviewDraftKey({
    ...scope,
    ...story.comparison,
    ignoreWhitespace: story.comparison.ignoreWhitespace === true,
    snapshotFingerprint: story.fingerprint,
  });
  const attachment = useReviewAttachmentSnapshot({
    key,
    cwd: scope.cwd,
    mode: story.comparison.mode,
    baseRef: story.comparison.baseRef,
    diffFiles: story.files,
  });
  const active = useRetainedPanelActive();
  usePublishWorkingDiffAttachment({ ...scope, attachment, enabled: active });
  const actions = useInlineReviewController({ reviewDraftKey: key });
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const index = story.outline.chapters.indexOf(chapter);
  const previous = story.outline.chapters[index - 1];
  const next = story.outline.chapters[index + 1];
  const openPrevious = useCallback(() => {
    if (previous) openTab({ kind: "chapter", selectionId: previous.id, category: false });
  }, [previous, openTab]);
  const openNext = useCallback(() => {
    if (next) openTab({ kind: "chapter", selectionId: next.id, category: false });
  }, [next, openTab]);
  const mode = useMemo(
    () => ({
      kind: "working" as const,
      reviewActions: { ...actions, readOnly: stale, editor: stale ? null : actions.editor },
    }),
    [actions, stale],
  );
  const collapseState = useMemo(() => ({ paths: collapsed, onChange: setCollapsed }), [collapsed]);
  return (
    <View style={styles.container}>
      <View style={styles.introduction}>
        <View style={styles.category}>
          <Button variant="ghost" disabled={!previous} onPress={openPrevious}>
            {t("chapters.previous")}
          </Button>
          <Text style={styles.muted}>
            {index + 1} / {story.outline.chapters.length}
          </Text>
          <Button variant="ghost" disabled={!next} onPress={openNext}>
            {t("chapters.next")}
          </Button>
          {canUseSplitLayout ? (
            <DiffLayoutToggle
              isMobile={isCompact}
              layout={displayPreferences.layout}
              onToggle={toggleLayout}
            />
          ) : null}
        </View>
        <Text style={styles.heading}>{chapter.title}</Text>
        <Text selectable style={styles.description}>
          {chapter.description}
        </Text>
        <Text selectable style={styles.muted}>
          {files.map((file) => file.path).join(" · ")}
        </Text>
      </View>
      <DiffDocument
        files={files}
        displayPreferences={displayPreferences}
        mode={mode}
        collapseState={collapseState}
      />
    </View>
  );
}

const presentation = {
  label: (t) => t("chapters.title"),
  subtitle: (t) => t("chapters.subtitle"),
  tooltip: (t) => t("chapters.title"),
  icon: ThemedBook,
} satisfies PanelPresentation;
export const chaptersPanelRegistration = definePanel("chapters", {
  component: ChaptersPanel,
  presentation,
});
export const chapterPanelRegistration = definePanel("chapter", {
  component: ChapterPanel,
  presentation,
});
