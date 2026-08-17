import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { View, Text, TextInput, Pressable, type PressableStateCallbackType } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { Check, X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { PendingPermission } from "@/types/shared";
import type { AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import { isWeb } from "@/constants/platform";
import {
  parseQuestionFormQuestions,
  questionShowsTextInput,
  resolveDismissLabel,
  shouldSubmitEmptyOnDismiss,
  type QuestionFormOption,
  type QuestionFormQuestion,
} from "./question-form-model";
import { buildQuestionPermissionAnswers } from "./question-form-permission-adapter";
import { useQuestionFormModel } from "./use-question-form-model";

interface QuestionFormCardProps {
  permission: PendingPermission;
  onRespond: (response: AgentPermissionResponse) => void;
  isResponding: boolean;
}

const IS_WEB = isWeb;

function getQuestionInputPlaceholder({
  question,
  answerPlaceholder,
  otherPlaceholder,
}: {
  question: QuestionFormQuestion;
  answerPlaceholder: string;
  otherPlaceholder: string;
}): string {
  return (
    question.placeholder ?? (question.options.length === 0 ? answerPlaceholder : otherPlaceholder)
  );
}

interface QuestionOptionRowProps {
  questionKey: string;
  option: QuestionFormOption;
  isSelected: boolean;
  multiSelect: boolean;
  isResponding: boolean;
  onToggle: (questionKey: string, optionValue: string) => void;
}

function QuestionOptionRow({
  questionKey,
  option,
  isSelected,
  multiSelect,
  isResponding,
  onToggle,
}: QuestionOptionRowProps) {
  const { theme } = useUnistyles();

  const handlePress = useCallback(() => {
    onToggle(questionKey, option.value);
  }, [onToggle, option.value, questionKey]);

  const pressableStyle = useCallback(
    ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.optionItem,
      (Boolean(hovered) || isSelected) && {
        backgroundColor: theme.colors.surface2,
      },
      pressed && styles.optionItemPressed,
    ],
    [isSelected, theme.colors.surface2],
  );

  const optionLabelStyle = useMemo(
    () => [styles.optionLabel, { color: theme.colors.foreground }],
    [theme.colors.foreground],
  );
  const optionDescriptionStyle = useMemo(
    () => [styles.optionDescription, { color: theme.colors.foregroundMuted }],
    [theme.colors.foregroundMuted],
  );
  const accessibilityState = useMemo(() => ({ checked: isSelected }), [isSelected]);

  // Static left-side control: square for multi-select, circle for single-select.
  // Always rendered so toggling only swaps fill/border — the row never reflows.
  const controlStyle = useMemo(
    () => [
      styles.selectionControl,
      multiSelect ? styles.selectionControlCheckbox : styles.selectionControlRadio,
      {
        borderColor: isSelected ? theme.colors.accent : theme.colors.foregroundMuted,
        backgroundColor: isSelected && multiSelect ? theme.colors.accent : "transparent",
      },
    ],
    [isSelected, multiSelect, theme.colors.accent, theme.colors.foregroundMuted],
  );
  const radioDotStyle = useMemo(
    () => [styles.selectionRadioDot, { backgroundColor: theme.colors.accent }],
    [theme.colors.accent],
  );

  return (
    <Pressable
      style={pressableStyle}
      onPress={handlePress}
      disabled={isResponding}
      accessibilityRole={multiSelect ? "checkbox" : "radio"}
      accessibilityLabel={option.label}
      accessibilityState={accessibilityState}
      aria-checked={isSelected}
    >
      <View style={styles.optionItemContent}>
        <View style={controlStyle}>
          {isSelected && multiSelect ? (
            <Check size={12} color={theme.colors.accentForeground} />
          ) : null}
          {isSelected && !multiSelect ? <View style={radioDotStyle} /> : null}
        </View>
        <View style={styles.optionTextBlock}>
          <Text style={optionLabelStyle}>{option.label}</Text>
          {option.description ? (
            <Text style={optionDescriptionStyle}>{option.description}</Text>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

interface QuestionNavButtonProps {
  index: number;
  total: number;
  header: string;
  isActive: boolean;
  isAnswered: boolean;
  isResponding: boolean;
  onSelect: (index: number) => void;
}

function QuestionNavButton({
  index,
  total,
  header,
  isActive,
  isAnswered,
  isResponding,
  onSelect,
}: QuestionNavButtonProps) {
  const { theme } = useUnistyles();
  const accessibilityState = useMemo(() => ({ selected: isActive }), [isActive]);
  const handlePress = useCallback(() => {
    onSelect(index);
  }, [index, onSelect]);
  const pressableStyle = useCallback(
    ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }) => {
      return [
        styles.questionNavButton,
        {
          backgroundColor:
            isActive || Boolean(hovered) ? theme.colors.surface2 : theme.colors.surface1,
          borderColor: isActive ? theme.colors.foregroundMuted : theme.colors.border,
        },
        pressed && styles.optionItemPressed,
      ];
    },
    [
      isActive,
      theme.colors.border,
      theme.colors.foregroundMuted,
      theme.colors.surface1,
      theme.colors.surface2,
    ],
  );
  const textStyle = useMemo(
    () => [
      styles.questionNavText,
      { color: isActive ? theme.colors.foreground : theme.colors.foregroundMuted },
    ],
    [isActive, theme.colors.foreground, theme.colors.foregroundMuted],
  );

  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityLabel={`Question ${index + 1} of ${total}`}
      accessibilityState={accessibilityState}
      aria-selected={isActive}
      testID={`question-form-question-nav-${index + 1}`}
      style={pressableStyle}
      onPress={handlePress}
      disabled={isResponding}
    >
      {isAnswered ? (
        <Check
          size={12}
          color={isActive ? theme.colors.foreground : theme.colors.foregroundMuted}
        />
      ) : null}
      <Text style={textStyle} numberOfLines={1}>
        {header}
      </Text>
    </Pressable>
  );
}

interface QuestionNavProps {
  questions: readonly QuestionFormQuestion[];
  activeIndex: number;
  isAnswered: (qIndex: number) => boolean;
  isResponding: boolean;
  onSelect: (index: number) => void;
}

// Titled tabs (one per question header) with a check on answered ones. Hidden for
// a lone question — a single "1 of 1" tab carries no information.
function QuestionNav({
  questions,
  activeIndex,
  isAnswered,
  isResponding,
  onSelect,
}: QuestionNavProps) {
  if (questions.length <= 1) {
    return null;
  }
  return (
    <View
      style={styles.questionNav}
      testID="question-form-question-nav"
      accessibilityRole="tablist"
    >
      {questions.map((question, qIndex) => (
        <QuestionNavButton
          key={question.key}
          index={qIndex}
          total={questions.length}
          header={question.header}
          isActive={qIndex === activeIndex}
          isAnswered={isAnswered(qIndex)}
          isResponding={isResponding}
          onSelect={onSelect}
        />
      ))}
    </View>
  );
}

interface QuestionOtherInputProps {
  questionKey: string;
  accessibilityLabel: string;
  value: string;
  placeholder: string;
  isResponding: boolean;
  onChange: (questionKey: string, text: string) => void;
  onSubmit: () => void;
}

function QuestionOtherInput({
  questionKey,
  accessibilityLabel,
  value,
  placeholder,
  isResponding,
  onChange,
  onSubmit,
}: QuestionOtherInputProps) {
  const { theme } = useUnistyles();
  const handleChange = useCallback(
    (text: string) => {
      onChange(questionKey, text);
    },
    [onChange, questionKey],
  );
  const otherInputStyle = useMemo(
    () =>
      [
        styles.otherInput,
        {
          borderColor: value.length > 0 ? theme.colors.borderAccent : theme.colors.border,
          color: theme.colors.foreground,
          backgroundColor: theme.colors.surface2,
        },
        IS_WEB ? { outlineStyle: "none", outlineWidth: 0, outlineColor: "transparent" } : null,
      ] as const,
    [
      value.length,
      theme.colors.borderAccent,
      theme.colors.border,
      theme.colors.foreground,
      theme.colors.surface2,
    ],
  );
  return (
    <TextInput
      // @ts-expect-error - outlineStyle is web-only
      style={otherInputStyle}
      accessibilityLabel={accessibilityLabel}
      placeholder={placeholder}
      placeholderTextColor={theme.colors.foregroundMuted}
      value={value}
      onChangeText={handleChange}
      onSubmitEditing={onSubmit}
      editable={!isResponding}
      blurOnSubmit={false}
    />
  );
}

interface QuestionFormCardBodyProps extends QuestionFormCardProps {
  questions: readonly QuestionFormQuestion[];
}

function QuestionFormCardBody({
  permission,
  onRespond,
  isResponding,
  questions,
}: QuestionFormCardBodyProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const isMobile = useIsCompactFormFactor();
  const model = useQuestionFormModel(questions);
  const form = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const [respondingAction, setRespondingAction] = useState<"submit" | "dismiss" | null>(null);
  const activeQuestion = form.questions[form.activeQuestionIndex];
  const activeQuestionAnswered = activeQuestion
    ? form.answeredQuestionKeys.has(activeQuestion.key)
    : false;
  const isLastQuestion = form.activeQuestionIndex === form.questions.length - 1;

  const handleSubmit = useCallback(() => {
    if (!form.canSubmit || isResponding) return;
    setRespondingAction("submit");
    onRespond({
      behavior: "allow",
      updatedInput: {
        ...permission.request.input,
        answers: buildQuestionPermissionAnswers(form, model.getAnswers()),
      },
    });
  }, [form, isResponding, model, onRespond, permission.request.input]);

  const handleDeny = useCallback(() => {
    setRespondingAction("dismiss");
    if (shouldSubmitEmptyOnDismiss(questions)) {
      onRespond({
        behavior: "allow",
        updatedInput: {
          ...permission.request.input,
          answers: buildQuestionPermissionAnswers(form, model.getAnswers()),
        },
      });
      return;
    }
    onRespond({
      behavior: "deny",
      message: "Dismissed by user",
    });
  }, [form, model, onRespond, permission.request.input, questions]);

  const handleSelectQuestion = useCallback(
    (index: number) => {
      model.setActiveQuestion(index);
    },
    [model],
  );

  const navIsAnswered = useCallback(
    (qIndex: number) => {
      const question = form.questions[qIndex];
      return question ? form.answeredQuestionKeys.has(question.key) : false;
    },
    [form.answeredQuestionKeys, form.questions],
  );

  const handlePrimaryAction = useCallback(() => {
    if (!isLastQuestion) {
      if (!activeQuestionAnswered || isResponding) return;
      model.advance();
      return;
    }
    handleSubmit();
  }, [activeQuestionAnswered, handleSubmit, isLastQuestion, isResponding, model]);

  const dismissButtonStyle = useCallback(
    ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.actionButton,
      {
        backgroundColor: hovered ? theme.colors.surface2 : theme.colors.surface1,
        borderColor: theme.colors.borderAccent,
      },
      pressed && styles.optionItemPressed,
    ],
    [theme.colors.surface2, theme.colors.surface1, theme.colors.borderAccent],
  );

  const primaryDisabled =
    isResponding || (isLastQuestion ? !form.canSubmit : !activeQuestionAnswered);
  const primaryActionLabel = isLastQuestion
    ? t("message.question.submit")
    : t("message.question.next");
  const submitButtonStyle = useCallback(
    ({ pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.actionButton,
      {
        backgroundColor: theme.colors.accent,
        borderColor: theme.colors.accent,
        opacity: primaryDisabled ? 0.5 : 1,
      },
      pressed && !primaryDisabled ? styles.optionItemPressed : null,
    ],
    [primaryDisabled, theme.colors.accent],
  );

  const containerStyle = useMemo(
    () => [
      styles.container,
      {
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
      },
    ],
    [theme.colors.surface1, theme.colors.border],
  );
  const questionTextStyle = useMemo(
    () => [styles.questionText, { color: theme.colors.foreground }],
    [theme.colors.foreground],
  );
  // Single-select radios need a group; checkboxes are valid standalone.
  const optionsGroupAccessibility = useMemo(
    () =>
      activeQuestion?.kind === "single-select"
        ? ({
            accessibilityRole: "radiogroup",
            accessibilityLabel: activeQuestion.question,
          } as const)
        : {},
    [activeQuestion],
  );
  const actionsContainerStyle = useMemo(
    () => [styles.actionsContainer, !isMobile && styles.actionsContainerDesktop],
    [isMobile],
  );
  const dismissActionTextStyle = useMemo(
    () => [styles.actionText, { color: theme.colors.foregroundMuted }],
    [theme.colors.foregroundMuted],
  );
  const submitActionTextColor = theme.colors.accentForeground;
  const submitActionTextStyle = useMemo(
    () => [styles.actionText, { color: submitActionTextColor }],
    [submitActionTextColor],
  );

  const dismissLabel = resolveDismissLabel(questions, t("common.actions.dismiss"));
  const selected = activeQuestion
    ? (form.selectedOptionValues.get(activeQuestion.key) ?? new Set<string>())
    : new Set<string>();
  const otherText = activeQuestion ? (form.textAnswers.get(activeQuestion.key) ?? "") : "";
  const showTextInput = activeQuestion ? questionShowsTextInput(activeQuestion) : false;

  return (
    <View style={containerStyle} testID="question-form-card">
      <QuestionNav
        questions={form.questions}
        activeIndex={form.activeQuestionIndex}
        isAnswered={navIsAnswered}
        isResponding={isResponding}
        onSelect={handleSelectQuestion}
      />
      <View style={styles.questionHeader}>
        <Text testID="question-form-current-question" style={questionTextStyle}>
          {activeQuestion?.question}
        </Text>
      </View>

      {activeQuestion ? (
        <View key={activeQuestion.key} style={styles.questionBlock}>
          {activeQuestion.options.length > 0 ? (
            <View style={styles.optionsWrap} {...optionsGroupAccessibility}>
              {activeQuestion.options.map((opt) => (
                <QuestionOptionRow
                  key={opt.value}
                  questionKey={activeQuestion.key}
                  option={opt}
                  isSelected={selected.has(opt.value)}
                  multiSelect={activeQuestion.kind === "multi-select"}
                  isResponding={isResponding}
                  onToggle={model.toggleOption}
                />
              ))}
            </View>
          ) : null}
          {showTextInput ? (
            <QuestionOtherInput
              questionKey={activeQuestion.key}
              accessibilityLabel={activeQuestion.question}
              value={otherText}
              placeholder={getQuestionInputPlaceholder({
                question: activeQuestion,
                answerPlaceholder: t("message.question.answerPlaceholder"),
                otherPlaceholder: t("message.question.otherPlaceholder"),
              })}
              isResponding={isResponding}
              onChange={model.setTextAnswer}
              onSubmit={handlePrimaryAction}
            />
          ) : null}
        </View>
      ) : null}

      <View style={actionsContainerStyle}>
        <Pressable
          style={dismissButtonStyle}
          onPress={handleDeny}
          disabled={isResponding}
          accessibilityRole="button"
          accessibilityLabel={dismissLabel}
          testID="question-form-dismiss"
        >
          {respondingAction === "dismiss" ? (
            <LoadingSpinner size="small" color={theme.colors.foregroundMuted} />
          ) : (
            <View style={styles.actionContent}>
              <X size={14} color={theme.colors.foregroundMuted} />
              <Text style={dismissActionTextStyle}>{dismissLabel}</Text>
            </View>
          )}
        </Pressable>

        <Pressable
          style={submitButtonStyle}
          onPress={handlePrimaryAction}
          disabled={primaryDisabled}
          accessibilityRole="button"
          accessibilityLabel={primaryActionLabel}
          testID="question-form-primary-action"
        >
          {respondingAction === "submit" ? (
            <LoadingSpinner size="small" color={theme.colors.accentForeground} />
          ) : (
            <View style={styles.actionContent}>
              <Check size={14} color={submitActionTextColor} />
              <Text style={submitActionTextStyle}>{primaryActionLabel}</Text>
            </View>
          )}
        </Pressable>
      </View>
    </View>
  );
}

export function QuestionFormCard({ permission, onRespond, isResponding }: QuestionFormCardProps) {
  const questions = useMemo(
    () => parseQuestionFormQuestions(permission.request.input),
    [permission.request.input],
  );

  if (!questions) {
    return null;
  }

  return (
    <QuestionFormCardBody
      key={permission.request.id}
      permission={permission}
      onRespond={onRespond}
      isResponding={isResponding}
      questions={questions}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    padding: theme.spacing[3],
    borderRadius: theme.spacing[2],
    borderWidth: 1,
    gap: theme.spacing[3],
  },
  questionBlock: {
    gap: theme.spacing[2],
  },
  questionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[1],
    flex: 1,
  },
  questionText: {
    flex: 1,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    lineHeight: 22,
  },
  optionsWrap: {
    gap: theme.spacing[1],
  },
  questionNav: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
  },
  questionNavButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    minHeight: 28,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
  },
  questionNavText: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  optionItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  optionItemPressed: {
    opacity: 0.9,
  },
  optionItemContent: {
    flex: 1,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
  },
  optionTextBlock: {
    flex: 1,
    gap: theme.spacing[1],
  },
  optionLabel: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    lineHeight: 22,
  },
  optionDescription: {
    fontSize: theme.fontSize.base,
    lineHeight: 20,
  },
  selectionControl: {
    width: 18,
    height: 18,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: theme.borderWidth[1],
    marginTop: 2, // optical-align 18px control to the 22px label first line
  },
  selectionControlCheckbox: {
    borderRadius: theme.borderRadius.base,
  },
  selectionControlRadio: {
    borderRadius: 999,
  },
  selectionRadioDot: {
    width: 8,
    height: 8,
    borderRadius: 999,
  },
  otherInput: {
    borderWidth: 1,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    fontSize: theme.fontSize.base,
  },
  actionsContainer: {
    gap: theme.spacing[2],
  },
  actionsContainerDesktop: {
    flexDirection: "row",
    justifyContent: "flex-start",
    alignItems: "center",
  },
  actionButton: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    borderWidth: theme.borderWidth[1],
  },
  actionContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  actionText: {
    fontSize: theme.fontSize.base,
  },
}));
