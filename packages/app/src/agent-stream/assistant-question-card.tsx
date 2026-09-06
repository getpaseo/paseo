import { memo, useCallback, useMemo, useState } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { AdaptiveTextInput } from "@/components/adaptive-text-input";
import { Button } from "@/components/ui/button";
import {
  questionShowsTextInput,
  type QuestionOtherTexts,
  type QuestionSelections,
} from "@/components/question-form-card-core";
import type { AssistantQuestion } from "@/timeline/assistant-questions";
import {
  formatAssistantQuestionMessage,
  initialAssistantQuestionSelections,
  isAssistantQuestionAnswerable,
  resolveAssistantQuestionAnswers,
  toQuestionFormQuestion,
} from "./assistant-question-card-core";

interface AssistantQuestionCardProps {
  questions: AssistantQuestion[];
  /** A later user message already answered this, so only the prompt is left to read. */
  answeredInTimeline: boolean;
  readOnly?: boolean;
  onSubmit: (text: string) => Promise<void>;
}

type SubmitStatus = "idle" | "sending" | "sent" | "failed";

interface OptionPillProps {
  questionIndex: number;
  optionIndex: number;
  label: string;
  selected: boolean;
  disabled: boolean;
  onSelect: (questionIndex: number, optionIndex: number) => void;
}

const CHECKED_ACCESSIBILITY_STATE = { checked: true } as const;
const UNCHECKED_ACCESSIBILITY_STATE = { checked: false } as const;

function OptionPill({
  questionIndex,
  optionIndex,
  label,
  selected,
  disabled,
  onSelect,
}: OptionPillProps) {
  const handlePress = useCallback(() => {
    onSelect(questionIndex, optionIndex);
  }, [onSelect, optionIndex, questionIndex]);

  const pillStyle = useCallback(
    ({ hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.optionPill,
      hovered ? styles.optionPillHovered : null,
      selected ? styles.optionPillSelected : null,
      disabled ? styles.optionPillDisabled : null,
    ],
    [disabled, selected],
  );
  const accessibilityState = selected ? CHECKED_ACCESSIBILITY_STATE : UNCHECKED_ACCESSIBILITY_STATE;

  return (
    <Pressable
      style={pillStyle}
      onPress={handlePress}
      disabled={disabled}
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={accessibilityState}
      aria-checked={selected}
    >
      <Text style={selected ? styles.optionLabelSelected : styles.optionLabel}>{label}</Text>
    </Pressable>
  );
}

interface QuestionAnswerInputProps {
  questionIndex: number;
  label: string;
  placeholder: string;
  resetKey: number;
  editable: boolean;
  onChange: (questionIndex: number, text: string) => void;
  onSubmit: () => void;
}

function QuestionAnswerInput({
  questionIndex,
  label,
  placeholder,
  resetKey,
  editable,
  onChange,
  onSubmit,
}: QuestionAnswerInputProps) {
  const handleChangeText = useCallback(
    (text: string) => {
      onChange(questionIndex, text);
    },
    [onChange, questionIndex],
  );

  return (
    <AdaptiveTextInput
      style={styles.otherInput}
      accessibilityLabel={label}
      placeholder={placeholder}
      initialValue=""
      resetKey={resetKey}
      editable={editable}
      onChangeText={handleChangeText}
      onSubmitEditing={onSubmit}
      blurOnSubmit={false}
    />
  );
}

export const AssistantQuestionCard = memo(function AssistantQuestionCard({
  questions,
  answeredInTimeline,
  readOnly = false,
  onSubmit,
}: AssistantQuestionCardProps) {
  const { t } = useTranslation();
  const formQuestions = useMemo(() => questions.map(toQuestionFormQuestion), [questions]);
  const [selections, setSelections] = useState<QuestionSelections>(() =>
    initialAssistantQuestionSelections(questions),
  );
  const [otherTexts, setOtherTexts] = useState<QuestionOtherTexts>({});
  // Bumped when picking an option, so the uncontrolled free-text field clears with the state.
  const [textResetKeys, setTextResetKeys] = useState<Record<number, number>>({});
  const [status, setStatus] = useState<SubmitStatus>("idle");
  const [sentAnswers, setSentAnswers] = useState<string[] | null>(null);

  const selectOption = useCallback((questionIndex: number, optionIndex: number) => {
    setSelections((previous) => ({ ...previous, [questionIndex]: new Set([optionIndex]) }));
    setOtherTexts((previous) => {
      if (!previous[questionIndex]) return previous;
      const next = { ...previous };
      delete next[questionIndex];
      return next;
    });
    setTextResetKeys((previous) => ({
      ...previous,
      [questionIndex]: (previous[questionIndex] ?? 0) + 1,
    }));
  }, []);

  const setOtherText = useCallback((questionIndex: number, text: string) => {
    setOtherTexts((previous) => ({ ...previous, [questionIndex]: text }));
    if (text.length === 0) return;
    setSelections((previous) => {
      if (!previous[questionIndex] || previous[questionIndex].size === 0) return previous;
      return { ...previous, [questionIndex]: new Set<number>() };
    });
  }, []);

  const handleSubmit = useCallback(async () => {
    const answers = resolveAssistantQuestionAnswers(formQuestions, selections, otherTexts);
    if (!answers) return;
    setStatus("sending");
    try {
      await onSubmit(formatAssistantQuestionMessage(formQuestions, answers));
      setSentAnswers(answers);
      setStatus("sent");
    } catch {
      setStatus("failed");
    }
  }, [formQuestions, onSubmit, otherTexts, selections]);

  const isAnswered = status === "sent" || answeredInTimeline;
  const isInteractive = !isAnswered && !readOnly;
  const canSubmit =
    status !== "sending" && isAssistantQuestionAnswerable(formQuestions, selections, otherTexts);

  return (
    <View style={styles.card} testID="assistant-question-card">
      {formQuestions.map((question, questionIndex) => {
        const selected = selections[questionIndex];
        const answer = sentAnswers?.[questionIndex];
        return (
          <View key={question.header} style={styles.questionBlock}>
            <Text style={styles.questionTitle}>{question.question}</Text>
            {answer ? (
              <Text testID="assistant-question-answer" style={styles.answerText}>
                {answer}
              </Text>
            ) : null}
            {isInteractive && question.options.length > 0 ? (
              <View
                style={styles.optionsWrap}
                accessibilityRole="radiogroup"
                accessibilityLabel={question.question}
              >
                {question.options.map((option, optionIndex) => (
                  <OptionPill
                    key={option.label}
                    questionIndex={questionIndex}
                    optionIndex={optionIndex}
                    label={option.label}
                    selected={selected?.has(optionIndex) === true}
                    disabled={status === "sending"}
                    onSelect={selectOption}
                  />
                ))}
              </View>
            ) : null}
            {isInteractive && questionShowsTextInput(question) ? (
              <QuestionAnswerInput
                questionIndex={questionIndex}
                label={question.question}
                placeholder={t("agentStream.questions.answerPlaceholder")}
                resetKey={textResetKeys[questionIndex] ?? 0}
                editable={status !== "sending"}
                onChange={setOtherText}
                onSubmit={handleSubmit}
              />
            ) : null}
          </View>
        );
      })}

      {isInteractive ? (
        <View style={styles.footer}>
          <Button
            size="sm"
            onPress={handleSubmit}
            disabled={!canSubmit}
            loading={status === "sending"}
            accessibilityLabel={t("agentStream.questions.submit")}
            testID="assistant-question-submit"
          >
            {t("agentStream.questions.submit")}
          </Button>
          {status === "failed" ? (
            <Text style={styles.errorText}>{t("agentStream.questions.sendFailed")}</Text>
          ) : null}
        </View>
      ) : null}

      {isAnswered && !sentAnswers ? (
        <Text style={styles.answeredLabel}>{t("agentStream.questions.answered")}</Text>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  card: {
    marginBottom: theme.spacing[3],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    gap: theme.spacing[3],
  },
  questionBlock: {
    gap: theme.spacing[2],
  },
  questionTitle: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  optionsWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  optionPill: {
    minHeight: 28,
    justifyContent: "center",
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  optionPillHovered: {
    backgroundColor: theme.colors.surface2,
  },
  optionPillSelected: {
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.surface2,
  },
  optionPillDisabled: {
    opacity: theme.opacity[50],
  },
  optionLabel: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
  },
  optionLabelSelected: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
  },
  otherInput: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    fontSize: theme.fontSize.base,
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  answerText: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
  },
  answeredLabel: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  errorText: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    color: theme.colors.palette.red[300],
  },
}));
