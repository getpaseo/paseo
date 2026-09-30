import { useCallback, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { WorkspaceTopic } from "@getpaseo/protocol/messages";
import {
  AdaptiveModalSheet,
  AdaptiveTextInput,
  type SheetHeader,
} from "@/components/adaptive-modal-sheet";
import { Check } from "@/components/icons/ui-icons";
import { Button } from "@/components/ui/button";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import type { Theme } from "@/styles/theme";
import { planCombineIntoTopic, type CombineIntoTopicChoice } from "./combine-into-topic-plan";
import { createWorkspaceTopicActions, useWorkspaceTopics } from "./use-workspace-topics";

export interface CombineIntoTopicDialogProps {
  visible: boolean;
  serverId: string;
  /** The sessions to put under one topic, usually the row the menu was opened on plus any selection. */
  workspaceIds: string[];
  onClose: () => void;
  testID?: string;
}

const ThemedCheck = withUnistyles(Check);
const foregroundIconColor = (theme: Theme) => ({ color: theme.colors.foreground });

/** Mounted fresh per open so a previous draft never leaks into the next one. */
export function CombineIntoTopicDialog(props: CombineIntoTopicDialogProps) {
  if (!props.visible) return null;
  return <CombineIntoTopicSheet {...props} />;
}

function CombineIntoTopicSheet({
  serverId,
  workspaceIds,
  onClose,
  testID = "combine-into-topic",
}: CombineIntoTopicDialogProps) {
  const { t } = useTranslation();
  const { isSupported, topics } = useWorkspaceTopics(serverId);
  const [choice, setChoice] = useState<CombineIntoTopicChoice>({ kind: "new", title: "" });
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);
  const inputRef = useRef<EditingTextInputHandle>(null);
  const plan = planCombineIntoTopic({ choice, workspaceIds });
  const header = useMemo<SheetHeader>(() => ({ title: t("topics.combine.title") }), [t]);

  const handleTitleChange = useCallback((title: string) => {
    setChoice({ kind: "new", title });
    setError(null);
  }, []);

  const handlePickTopic = useCallback((topic: WorkspaceTopic) => {
    // A programmatic replace does not echo through onChangeText, so the pick stands.
    inputRef.current?.replaceText("");
    setChoice((current) =>
      current.kind === "existing" && current.topicId === topic.id
        ? { kind: "new", title: "" }
        : { kind: "existing", topicId: topic.id },
    );
    setError(null);
  }, []);

  const handleSubmit = useCallback(async () => {
    if (isPending) return;
    if (!plan) {
      setError(t("topics.errors.titleRequired"));
      return;
    }
    const actions = createWorkspaceTopicActions(serverId);
    try {
      setIsPending(true);
      if (plan.kind === "create") {
        await actions.createTopic({ title: plan.title, workspaceIds: plan.workspaceIds });
      } else {
        for (const workspaceId of plan.workspaceIds) {
          await actions.assignTopic(workspaceId, plan.topicId);
        }
      }
      onClose();
    } catch (err) {
      setIsPending(false);
      setError(err instanceof Error && err.message ? err.message : t("common.errors.unableToSave"));
    }
  }, [isPending, plan, serverId, onClose, t]);

  const handleSubmitVoid = useCallback(() => {
    void handleSubmit();
  }, [handleSubmit]);

  const handleCancel = useCallback(() => {
    if (!isPending) onClose();
  }, [isPending, onClose]);

  return (
    <AdaptiveModalSheet visible onClose={handleCancel} header={header} testID={testID}>
      {isSupported ? (
        <View style={styles.body}>
          <AdaptiveTextInput
            ref={inputRef}
            initialValue=""
            onChangeText={handleTitleChange}
            placeholder={t("topics.combine.namePlaceholder")}
            autoCorrect={false}
            editable={!isPending}
            onSubmitEditing={handleSubmitVoid}
            style={styles.input}
            testID={`${testID}-name`}
          />
          {topics.length > 0 ? (
            <View>
              <Text style={styles.sectionLabel}>{t("topics.combine.existing")}</Text>
              {topics.map((topic) => (
                <TopicOption
                  key={topic.id}
                  topic={topic}
                  selected={choice.kind === "existing" && choice.topicId === topic.id}
                  disabled={isPending}
                  onPick={handlePickTopic}
                  testID={`${testID}-topic-${topic.id}`}
                />
              ))}
            </View>
          ) : null}
          {error ? (
            <Text style={styles.errorText} testID={`${testID}-error`}>
              {error}
            </Text>
          ) : null}
          <View style={styles.actions}>
            <Button
              variant="secondary"
              size="sm"
              style={styles.actionButton}
              onPress={handleCancel}
              disabled={isPending}
              testID={`${testID}-cancel`}
            >
              {t("common.actions.cancel")}
            </Button>
            <Button
              variant="default"
              size="sm"
              style={styles.actionButton}
              onPress={handleSubmitVoid}
              disabled={isPending || !plan}
              testID={`${testID}-submit`}
            >
              {isPending ? t("topics.combine.submitting") : t("topics.combine.submit")}
            </Button>
          </View>
        </View>
      ) : (
        <View style={styles.body}>
          <Text style={styles.hint}>{t("topics.updateHostUse")}</Text>
        </View>
      )}
    </AdaptiveModalSheet>
  );
}

function TopicOption({
  topic,
  selected,
  disabled,
  onPick,
  testID,
}: {
  topic: WorkspaceTopic;
  selected: boolean;
  disabled: boolean;
  onPick: (topic: WorkspaceTopic) => void;
  testID: string;
}) {
  const handlePress = useCallback(() => onPick(topic), [onPick, topic]);
  const accessibilityState = useMemo(() => ({ selected, disabled }), [selected, disabled]);
  return (
    <Pressable
      onPress={handlePress}
      disabled={disabled}
      accessibilityRole="radio"
      accessibilityState={accessibilityState}
      style={styles.option}
      testID={testID}
    >
      <Text style={styles.optionTitle} numberOfLines={1}>
        {topic.title}
      </Text>
      <View style={styles.optionCheck}>
        {selected ? <ThemedCheck size={14} uniProps={foregroundIconColor} /> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  input: {
    backgroundColor: theme.colors.surface0,
    color: theme.colors.foreground,
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    fontSize: theme.fontSize.base,
  },
  sectionLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    paddingBottom: theme.spacing[1],
  },
  // Hairline-separated rows rather than cards: the choice is one of a list, not a set of objects.
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  optionTitle: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  optionCheck: {
    width: 14,
    alignItems: "center",
  },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  errorText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  actionButton: {
    flex: 1,
  },
}));
