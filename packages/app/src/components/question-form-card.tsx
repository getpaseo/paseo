import { LoadingSpinner } from "@/components/ui/loading-spinner";
import {
  Children,
  cloneElement,
  isValidElement,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  type PressableStateCallbackType,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import type { ASTNode, RenderRules } from "react-native-markdown-display";
import { useIsCompactFormFactor } from "@/constants/layout";
import { Check, X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { PendingPermission } from "@/types/shared";
import type { AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import { isWeb } from "@/constants/platform";
import {
  AssistantInlineCodePathLink,
  AssistantMarkdownLink,
  type AssistantFileLinkSource,
} from "@/assistant-file-links";
import { isFileLookingAssistantToken } from "@/assistant-file-links/parse";
import {
  createSharedMarkdownRules,
  MarkdownInheritedText,
  MarkdownRenderer,
  type MarkdownStyleOverrides,
  type MarkdownStyles,
} from "@/components/markdown/renderer";
import { createAssistantMarkdownParser } from "@/utils/assistant-markdown-parser";
import {
  areQuestionsAnswered,
  buildQuestionFormAnswers,
  isQuestionAnswered,
  parseQuestionFormQuestions,
  questionShowsTextInput,
  resolveDismissLabel,
  shouldSubmitEmptyOnDismiss,
  type QuestionFormQuestion,
  type QuestionOption,
} from "./question-form-card-core";

interface QuestionFormCardProps {
  permission: PendingPermission;
  onRespond: (response: AgentPermissionResponse) => void;
  isResponding: boolean;
}

const IS_WEB = isWeb;
const QUESTION_MARKDOWN_PARSER = createAssistantMarkdownParser();
const QUESTION_MARKDOWN_WEB_STYLE = IS_WEB ? ({ userSelect: "text" } as ViewStyle) : undefined;

type QuestionMarkdownVariant = "question" | "label" | "description";

function createQuestionMarkdownStyle(variant: QuestionMarkdownVariant): MarkdownStyleOverrides {
  return (theme) => {
    const text =
      variant === "description"
        ? {
            color: theme.colors.foregroundMuted,
            fontSize: theme.fontSize.sm,
            lineHeight: 20,
          }
        : {
            color: theme.colors.foreground,
            fontSize: theme.fontSize.base,
            fontWeight:
              variant === "question" ? theme.fontWeight.medium : theme.fontWeight.semibold,
            lineHeight: 22,
          };
    return {
      body: text,
      text,
      paragraph: { marginTop: 0, marginBottom: 0 },
    };
  };
}

const QUESTION_MARKDOWN_STYLES: Record<QuestionMarkdownVariant, MarkdownStyleOverrides> = {
  question: createQuestionMarkdownStyle("question"),
  label: createQuestionMarkdownStyle("label"),
  description: createQuestionMarkdownStyle("description"),
};

interface QuestionMarkdownAstNode extends ASTNode {
  sourceInfo?: string;
}

function getMarkdownNodeText(node: ASTNode): string {
  return node.children.length
    ? node.children.map(getMarkdownNodeText).join("")
    : (node.content ?? "");
}

function getQuestionLinkSource(node: QuestionMarkdownAstNode): AssistantFileLinkSource {
  return {
    href: typeof node.attributes?.href === "string" ? node.attributes.href : "",
    text: getMarkdownNodeText(node),
    title: typeof node.attributes?.title === "string" ? node.attributes.title : undefined,
    markup: node.markup,
    sourceInfo: node.sourceInfo,
  };
}

const QUESTION_MARKDOWN_RULES: RenderRules = {
  ...createSharedMarkdownRules(),
  code_inline: (
    node: ASTNode,
    _children: ReactNode[],
    _parent: ASTNode[],
    styles: MarkdownStyles,
    inheritedStyles: TextStyle = {},
  ) => {
    const content = node.content ?? "";
    if (isFileLookingAssistantToken(content)) {
      return (
        <AssistantInlineCodePathLink
          key={node.key}
          content={content}
          inheritedStyles={inheritedStyles}
          codeInlineStyle={styles.code_inline}
          linkStyle={styles.link}
        />
      );
    }
    return (
      <MarkdownInheritedText
        key={node.key}
        inheritedStyles={inheritedStyles}
        textStyle={styles.code_inline}
        monoSurface
      >
        {content}
      </MarkdownInheritedText>
    );
  },
  link: (node: ASTNode, children: ReactNode[], _parent: ASTNode[], styles: MarkdownStyles) => (
    <AssistantMarkdownLink key={node.key} source={getQuestionLinkSource(node)} style={styles.link}>
      {Children.map(children, (child) => {
        if (!isValidElement(child)) return child;
        const childProps = child.props as { style?: StyleProp<TextStyle> };
        return cloneElement(child, {
          style: [childProps.style, { color: styles.link.color }],
        } as Partial<{ style: StyleProp<TextStyle> }>);
      })}
    </AssistantMarkdownLink>
  ),
};

function QuestionMarkdownText({
  text,
  variant,
  testID,
}: {
  text: string;
  variant: QuestionMarkdownVariant;
  testID?: string;
}) {
  return (
    <View
      testID={testID}
      style={[
        styles.markdownText,
        variant === "question" && styles.questionText,
        QUESTION_MARKDOWN_WEB_STYLE,
      ]}
    >
      <MarkdownRenderer
        text={text}
        enableHtmlish={false}
        markdownit={QUESTION_MARKDOWN_PARSER}
        rules={QUESTION_MARKDOWN_RULES}
        style={QUESTION_MARKDOWN_STYLES[variant]}
      />
    </View>
  );
}

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
  qIndex: number;
  optIndex: number;
  option: QuestionOption;
  isSelected: boolean;
  multiSelect: boolean;
  isResponding: boolean;
  onToggle: (qIndex: number, optIndex: number, multiSelect: boolean) => void;
}

function QuestionOptionRow({
  qIndex,
  optIndex,
  option,
  isSelected,
  multiSelect,
  isResponding,
  onToggle,
}: QuestionOptionRowProps) {
  const { theme } = useUnistyles();

  const handlePressIn = useCallback(() => {
    if (IS_WEB) window.getSelection()?.removeAllRanges();
  }, []);
  const handlePress = useCallback(() => {
    if (IS_WEB && window.getSelection()?.toString()) return;
    onToggle(qIndex, optIndex, multiSelect);
  }, [onToggle, qIndex, optIndex, multiSelect]);

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
      onPressIn={handlePressIn}
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
          <QuestionMarkdownText
            text={option.label}
            variant="label"
            testID={`question-form-option-label-${qIndex}-${optIndex}`}
          />
          {option.description ? (
            <QuestionMarkdownText
              text={option.description}
              variant="description"
              testID={`question-form-option-description-${qIndex}-${optIndex}`}
            />
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
  questions: QuestionFormQuestion[];
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
          key={question.header}
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
  qIndex: number;
  accessibilityLabel: string;
  value: string;
  placeholder: string;
  isResponding: boolean;
  onChange: (qIndex: number, text: string) => void;
  onSubmit: () => void;
}

function QuestionOtherInput({
  qIndex,
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
      onChange(qIndex, text);
    },
    [onChange, qIndex],
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

export function QuestionFormCard({ permission, onRespond, isResponding }: QuestionFormCardProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const isMobile = useIsCompactFormFactor();
  const questions = useMemo(
    () => parseQuestionFormQuestions(permission.request.input),
    [permission.request.input],
  );

  const [selections, setSelections] = useState<Record<number, Set<number>>>({});
  const [otherTexts, setOtherTexts] = useState<Record<number, string>>({});
  const [respondingAction, setRespondingAction] = useState<"submit" | "dismiss" | null>(null);
  const [activeQuestionIndex, setActiveQuestionIndex] = useState(0);

  const toggleOption = useCallback(
    (qIndex: number, optIndex: number, multiSelect: boolean) => {
      const current = selections[qIndex] ?? new Set<number>();
      const next = new Set(current);
      if (multiSelect) {
        if (next.has(optIndex)) {
          next.delete(optIndex);
        } else {
          next.add(optIndex);
        }
      } else if (next.has(optIndex)) {
        next.clear();
      } else {
        next.clear();
        next.add(optIndex);
      }

      setSelections((prev) => ({ ...prev, [qIndex]: next }));
      setOtherTexts((prev) => {
        if (!prev[qIndex]) return prev;
        const nextTexts = { ...prev };
        delete nextTexts[qIndex];
        return nextTexts;
      });

      if (!multiSelect && next.size > 0 && qIndex === activeQuestionIndex && questions) {
        setActiveQuestionIndex(Math.min(qIndex + 1, questions.length - 1));
      }
    },
    [activeQuestionIndex, questions, selections],
  );

  const setOtherText = useCallback((qIndex: number, text: string) => {
    setOtherTexts((prev) => ({ ...prev, [qIndex]: text }));
    if (text.length > 0) {
      setSelections((prev) => {
        if (!prev[qIndex] || prev[qIndex].size === 0) return prev;
        return { ...prev, [qIndex]: new Set<number>() };
      });
    }
  }, []);

  const allAnswered = areQuestionsAnswered(questions, selections, otherTexts);
  const resolvedActiveQuestionIndex = questions
    ? Math.min(activeQuestionIndex, questions.length - 1)
    : 0;
  const activeQuestion = questions?.[resolvedActiveQuestionIndex];
  const activeQuestionAnswered = activeQuestion
    ? isQuestionAnswered(activeQuestion, resolvedActiveQuestionIndex, selections, otherTexts)
    : false;
  const isLastQuestion = questions ? resolvedActiveQuestionIndex === questions.length - 1 : true;

  const handleSubmit = useCallback(() => {
    if (!questions || !allAnswered || isResponding) return;
    setRespondingAction("submit");
    onRespond({
      behavior: "allow",
      updatedInput: {
        ...permission.request.input,
        answers: buildQuestionFormAnswers(questions, selections, otherTexts),
      },
    });
  }, [
    questions,
    allAnswered,
    isResponding,
    selections,
    otherTexts,
    onRespond,
    permission.request.input,
  ]);

  const handleDeny = useCallback(() => {
    if (!questions) return;
    setRespondingAction("dismiss");
    if (shouldSubmitEmptyOnDismiss(questions)) {
      onRespond({
        behavior: "allow",
        updatedInput: {
          ...permission.request.input,
          answers: buildQuestionFormAnswers(questions, selections, otherTexts),
        },
      });
      return;
    }
    onRespond({
      behavior: "deny",
      message: "Dismissed by user",
    });
  }, [questions, onRespond, otherTexts, permission.request.input, selections]);

  const handleSelectQuestion = useCallback((index: number) => {
    setActiveQuestionIndex(index);
  }, []);

  const navIsAnswered = useCallback(
    (qIndex: number) =>
      questions ? isQuestionAnswered(questions[qIndex], qIndex, selections, otherTexts) : false,
    [questions, selections, otherTexts],
  );

  const handlePrimaryAction = useCallback(() => {
    if (!isLastQuestion) {
      if (!activeQuestionAnswered || isResponding) return;
      setActiveQuestionIndex((index) => Math.min(index + 1, (questions?.length ?? 1) - 1));
      return;
    }
    handleSubmit();
  }, [activeQuestionAnswered, handleSubmit, isLastQuestion, isResponding, questions?.length]);

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

  const primaryDisabled = isResponding || (isLastQuestion ? !allAnswered : !activeQuestionAnswered);
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
  // Single-select radios need a group; checkboxes are valid standalone.
  const optionsGroupAccessibility = useMemo(
    () =>
      activeQuestion && !activeQuestion.multiSelect
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

  if (!questions) {
    return null;
  }

  const dismissLabel = resolveDismissLabel(questions, t("common.actions.dismiss"));
  const selected = selections[resolvedActiveQuestionIndex] ?? new Set<number>();
  const otherText = otherTexts[resolvedActiveQuestionIndex] ?? "";
  const showTextInput = activeQuestion ? questionShowsTextInput(activeQuestion) : false;

  return (
    <View style={containerStyle} testID="question-form-card">
      <QuestionNav
        questions={questions}
        activeIndex={resolvedActiveQuestionIndex}
        isAnswered={navIsAnswered}
        isResponding={isResponding}
        onSelect={handleSelectQuestion}
      />
      <View style={styles.questionHeader}>
        <QuestionMarkdownText
          text={activeQuestion?.question ?? ""}
          variant="question"
          testID="question-form-current-question"
        />
      </View>

      {activeQuestion ? (
        <View key={activeQuestion.question} style={styles.questionBlock}>
          {activeQuestion.options.length > 0 ? (
            <View style={styles.optionsWrap} {...optionsGroupAccessibility}>
              {activeQuestion.options.map((opt, optIndex) => (
                <QuestionOptionRow
                  key={opt.label}
                  qIndex={resolvedActiveQuestionIndex}
                  optIndex={optIndex}
                  option={opt}
                  isSelected={selected.has(optIndex)}
                  multiSelect={activeQuestion.multiSelect}
                  isResponding={isResponding}
                  onToggle={toggleOption}
                />
              ))}
            </View>
          ) : null}
          {showTextInput ? (
            <QuestionOtherInput
              qIndex={resolvedActiveQuestionIndex}
              accessibilityLabel={activeQuestion.question}
              value={otherText}
              placeholder={getQuestionInputPlaceholder({
                question: activeQuestion,
                answerPlaceholder: t("message.question.answerPlaceholder"),
                otherPlaceholder: t("message.question.otherPlaceholder"),
              })}
              isResponding={isResponding}
              onChange={setOtherText}
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
  markdownText: {
    minWidth: 0,
  },
  questionText: {
    flex: 1,
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
    fontSize: theme.fontSize.sm,
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
    fontSize: theme.fontSize.sm,
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
    fontSize: theme.fontSize.sm,
  },
}));
