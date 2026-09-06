import { useCallback, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { Assistant, AssistantHistoryEntry } from "@getpaseo/protocol/assistants";
import { Button } from "@/components/ui/button";
import type { FieldControlSize } from "@/components/ui/control-geometry";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { toErrorMessage } from "@/utils/error-messages";
import { useAssistantHistory } from "./assistant-queries";

const SUMMARY_MAX_LENGTH = 8000;

function describeEntry(t: TFunction, entry: AssistantHistoryEntry): string {
  switch (entry.kind) {
    case "transcript":
      return entry.text;
    case "call_started":
      return t("assistants.history.callStarted");
    case "call_ended":
      return t("assistants.history.callEnded", { cause: entry.cause });
    case "delegation":
      return entry.ok
        ? t("assistants.history.delegationOk", { description: entry.description })
        : t("assistants.history.delegationFailed", {
            description: entry.description,
            code: entry.errorCode ?? "error",
          });
  }
}

function HistoryEntryRow({
  entry,
  inSummary,
}: {
  entry: AssistantHistoryEntry;
  inSummary: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const isTranscript = entry.kind === "transcript";
  let speaker: string | null = null;
  if (entry.kind === "transcript")
    speaker = t(entry.role === "user" ? "assistants.history.user" : "assistants.history.assistant");
  return (
    <View
      style={[styles.entry, inSummary && styles.entryInSummary]}
      testID={`assistant-history-${entry.seq}`}
    >
      {speaker ? <Text style={styles.speaker}>{speaker}</Text> : null}
      <Text style={isTranscript ? styles.entryText : styles.entryMeta}>
        {describeEntry(t, entry)}
      </Text>
    </View>
  );
}

/**
 * What the assistant remembers, and the one knob the user has over it: the
 * summary that replaces older entries in the model's context. Entries at or
 * below `summaryThroughSeq` stay stored and readable here but are represented
 * to the model only by the summary.
 */
function summaryProjection(
  assistant: Assistant | null,
  draft: { text: string; base: Assistant } | null,
) {
  const summaryValue = draft?.text ?? assistant?.summary ?? "";
  const throughSeq = draft?.base.lastSeq ?? assistant?.lastSeq ?? 0;
  const summaryDirty =
    assistant !== null &&
    draft !== null &&
    (summaryValue.trim() !== assistant.summary.trim() || throughSeq > assistant.summaryThroughSeq);
  return { summaryValue, throughSeq, summaryDirty };
}

export function AssistantHistoryView({
  serverId,
  assistantId,
  disabled,
  onCompact,
}: {
  serverId: string;
  assistantId: string;
  disabled: boolean;
  onCompact: (input: {
    assistant: Assistant;
    summary: string;
    throughSeq: number;
  }) => Promise<void>;
}): ReactElement {
  const { t } = useTranslation();
  const size: FieldControlSize = useIsCompactFormFactor() ? "md" : "sm";
  const history = useAssistantHistory(serverId, assistantId);
  const assistant = history.assistant;
  const [summaryDraft, setSummaryDraft] = useState<{ text: string; base: Assistant } | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const { summaryValue, throughSeq, summaryDirty } = summaryProjection(assistant, summaryDraft);
  const handleSummaryChange = useCallback(
    (text: string) => {
      if (assistant) setSummaryDraft((current) => ({ text, base: current?.base ?? assistant }));
    },
    [assistant],
  );
  const handleSave = useCallback(async () => {
    if (!assistant) {
      return;
    }
    setIsSaving(true);
    setSummaryError(null);
    try {
      await onCompact({
        assistant: summaryDraft?.base ?? assistant,
        summary: summaryValue.trim(),
        throughSeq,
      });
      setSummaryDraft(null);
    } catch (error) {
      setSummaryError(toErrorMessage(error));
    } finally {
      setIsSaving(false);
    }
  }, [assistant, onCompact, summaryDraft, summaryValue, throughSeq]);
  const handleSavePress = useCallback(() => {
    void handleSave();
  }, [handleSave]);
  const handleLoadOlder = useCallback(() => {
    void history.loadOlder().catch((error) => setSummaryError(toErrorMessage(error)));
  }, [history]);

  if (history.error) {
    return <Text style={styles.error}>{toErrorMessage(history.error)}</Text>;
  }
  if (!assistant) {
    return <Text style={styles.muted}>{t("common.loading")}</Text>;
  }

  return (
    <View style={styles.container}>
      <Field
        label={t("assistants.history.summary.label")}
        hint={
          assistant.summaryThroughSeq > 0
            ? t("assistants.history.summary.coversThrough", { seq: assistant.summaryThroughSeq })
            : t("assistants.history.summary.hint")
        }
        error={summaryError}
        testID="assistant-summary-field"
      >
        <FormTextInput
          size={size}
          initialValue={summaryValue}
          resetKey={`${assistant.id}:${summaryDraft?.base.revision ?? assistant.revision}`}
          onChangeText={handleSummaryChange}
          editable={!disabled && !isSaving}
          placeholder={t("assistants.history.summary.placeholder")}
          maxLength={SUMMARY_MAX_LENGTH}
          style={styles.summaryInput}
          multiline
          numberOfLines={5}
          textAlignVertical="top"
          accessibilityLabel={t("assistants.history.summary.label")}
          testID="assistant-summary-input"
        />
      </Field>
      <View style={styles.summaryActions}>
        <Text style={styles.muted}>
          {t("assistants.history.summary.willCover", { seq: throughSeq })}
        </Text>
        <Button
          size="sm"
          disabled={disabled || !summaryDirty}
          loading={isSaving}
          onPress={handleSavePress}
          testID="assistant-summary-save"
        >
          {t("assistants.history.summary.save")}
        </Button>
      </View>

      <Text style={styles.sectionLabel}>{t("assistants.history.title")}</Text>
      {history.hasMore ? (
        <Button
          variant="ghost"
          size="sm"
          onPress={handleLoadOlder}
          loading={history.isLoadingOlder}
          disabled={history.isLoadingOlder}
          testID="assistant-history-load-older"
        >
          {t("assistants.history.loadOlder")}
        </Button>
      ) : null}
      {history.entries.length === 0 ? (
        <Text style={styles.muted}>{t("assistants.history.empty")}</Text>
      ) : (
        <View style={styles.entries}>
          {history.entries.map((entry) => (
            <HistoryEntryRow
              key={entry.seq}
              entry={entry}
              inSummary={entry.seq <= assistant.summaryThroughSeq}
            />
          ))}
        </View>
      )}
      <Text style={styles.muted}>{t("assistants.history.limits")}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[3],
  },
  summaryInput: {
    minHeight: 120,
  },
  summaryActions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  sectionLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    marginTop: theme.spacing[2],
  },
  entries: {
    gap: theme.spacing[2],
  },
  entry: {
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[1],
  },
  entryInSummary: {
    opacity: theme.opacity[50],
  },
  speaker: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  entryText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  entryMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  muted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
  },
}));
