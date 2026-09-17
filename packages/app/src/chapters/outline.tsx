import React, { useCallback, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { chapterChangedLines } from "@getpaseo/protocol/chapters";
import type { ChapterOutline, ChapterStory, ChapterState } from "@getpaseo/protocol/messages";
import { Button } from "@/components/ui/button";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { chapterStyles as styles } from "./styles";
export interface ChapterPresentationState {
  pending: boolean;
  stale: boolean;
  supported: boolean;
  connected: boolean;
  error: string | null | undefined;
  story: ChapterStory | null;
  state: ChapterState | undefined;
  regenerate: () => void;
}
type Selection = Extract<WorkspaceTabTarget, { kind: "chapter" }>;
type Chapter = ChapterOutline["chapters"][number];
export function ChapterStatus({ chapters }: { chapters: ChapterPresentationState }) {
  const { t } = useTranslation();
  const { pending, stale, supported, connected, error, story, state, regenerate } = chapters;
  if (!connected) return <Text style={styles.message}>{t("chapters.disconnected")}</Text>;
  if (!supported) return <Text style={styles.message}>{t("chapters.unsupported")}</Text>;
  return (
    <View style={styles.status}>
      {pending ? <Text style={styles.message}>{t("chapters.loading")}</Text> : null}
      {stale ? <Text style={styles.message}>{t("chapters.older")}</Text> : null}
      {error ? (
        <Text selectable style={styles.error}>
          {error}
        </Text>
      ) : null}
      {!story && !pending && !error ? (
        <Text style={styles.message}>{t("chapters.empty")}</Text>
      ) : null}
      {stale || error ? (
        <Button
          variant="ghost"
          disabled={pending || state?.status === "unsupported"}
          onPress={regenerate}
        >
          {t("chapters.regenerate")}
        </Button>
      ) : null}
    </View>
  );
}

export function ChapterRow({
  chapter,
  story,
  openTab,
}: {
  chapter: Chapter;
  story: ChapterStory;
  openTab: (target: Selection) => void;
}) {
  const { t } = useTranslation();
  const open = useCallback(
    () => openTab({ kind: "chapter", selectionId: chapter.id, category: false }),
    [openTab, chapter.id],
  );
  return (
    <Pressable
      accessibilityRole="button"
      style={styles.row}
      onPress={open}
      testID={`chapter-row-${chapter.id}`}
    >
      <Text style={styles.title}>{chapter.title}</Text>
      <Text style={styles.muted}>
        {t("chapters.lines", { count: chapterChangedLines(chapter.sections, story.files) })}
      </Text>
    </Pressable>
  );
}

function CategoryRow({
  category,
  story,
  openTab,
}: {
  category: ChapterOutline["categories"][number];
  story: ChapterStory;
  openTab: (target: Selection) => void;
}) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(false);
  const toggle = useCallback(() => setCollapsed((value) => !value), []);
  const open = useCallback(
    () => openTab({ kind: "chapter", selectionId: category.id, category: true }),
    [openTab, category.id],
  );
  const chapters = story.outline.chapters.filter((chapter) =>
    category.chapterIds.includes(chapter.id),
  );
  return (
    <View>
      <View style={styles.category}>
        <Button
          variant="ghost"
          accessibilityLabel={t(collapsed ? "chapters.expand" : "chapters.collapse")}
          onPress={toggle}
        >
          {collapsed ? "+" : "−"}
        </Button>
        <Pressable accessibilityRole="button" style={styles.fill} onPress={open}>
          <Text style={styles.title}>{category.title}</Text>
        </Pressable>
      </View>
      {!collapsed
        ? chapters.map((chapter) => (
            <ChapterRow key={chapter.id} chapter={chapter} story={story} openTab={openTab} />
          ))
        : null}
    </View>
  );
}

export function ChaptersOutline({
  chapters,
  openTab,
}: {
  chapters: ChapterPresentationState;
  openTab: (target: Selection) => void;
}) {
  const story = chapters.story;
  return (
    <View style={styles.container} testID="chapters-outline">
      <ChapterStatus chapters={chapters} />
      {story ? (
        <ScrollView>
          {story.outline.categories.length
            ? story.outline.categories.map((category) => (
                <CategoryRow
                  key={category.id}
                  category={category}
                  story={story}
                  openTab={openTab}
                />
              ))
            : story.outline.chapters.map((chapter) => (
                <ChapterRow key={chapter.id} chapter={chapter} story={story} openTab={openTab} />
              ))}
        </ScrollView>
      ) : null}
    </View>
  );
}
