import { useCallback, useState } from "react";
import { View, Text, TextInput, Pressable, ActivityIndicator, Platform } from "react-native";
import { StyleSheet, useUnistyles, UnistylesRuntime } from "react-native-unistyles";
import { Check, CircleHelp, X } from "lucide-react-native";
import type { PendingPermission } from "@/types/shared";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import type { AgentPermissionResponse } from "@server/server/agent/agent-sdk-types";

interface QuestionOption {
  label: string;
  description?: string;
}

interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

type QuestionSelections = Record<number, Set<number>>;
type QuestionOtherTexts = Record<number, string>;

function parseQuestions(input: unknown): Question[] | null {
  if (
    typeof input !== "object" ||
    input === null ||
    !("questions" in input) ||
    !Array.isArray((input as Record<string, unknown>).questions)
  ) {
    return null;
  }

  const raw = (input as Record<string, unknown>).questions as unknown[];
  const questions: Question[] = [];

  for (const item of raw) {
    if (typeof item !== "object" || item === null) {
      return null;
    }

    const question = item as Record<string, unknown>;
    if (typeof question.question !== "string" || typeof question.header !== "string") {
      return null;
    }
    if (!Array.isArray(question.options)) {
      return null;
    }

    const options: QuestionOption[] = [];
    for (const option of question.options as unknown[]) {
      if (typeof option !== "object" || option === null) {
        return null;
      }

      const candidate = option as Record<string, unknown>;
      if (typeof candidate.label !== "string") {
        return null;
      }

      options.push({
        label: candidate.label,
        description: typeof candidate.description === "string" ? candidate.description : undefined,
      });
    }

    questions.push({
      question: question.question,
      header: question.header,
      options,
      multiSelect: question.multiSelect === true,
    });
  }

  return questions.length > 0 ? questions : null;
}

function cloneSelections(input: QuestionSelections): QuestionSelections {
  const next: QuestionSelections = {};
  for (const [key, value] of Object.entries(input)) {
    next[Number(key)] = new Set(value);
  }
  return next;
}

function isQuestionAnswered(input: {
  selections: QuestionSelections;
  otherTexts: QuestionOtherTexts;
  questionIndex: number;
}): boolean {
  const selected = input.selections[input.questionIndex];
  const otherText = input.otherTexts[input.questionIndex]?.trim();
  return (selected && selected.size > 0) || Boolean(otherText && otherText.length > 0);
}

function findFirstUnansweredQuestionIndex(input: {
  questions: readonly Question[];
  selections: QuestionSelections;
  otherTexts: QuestionOtherTexts;
}): number | null {
  for (let questionIndex = 0; questionIndex < input.questions.length; questionIndex += 1) {
    if (
      !isQuestionAnswered({
        selections: input.selections,
        otherTexts: input.otherTexts,
        questionIndex,
      })
    ) {
      return questionIndex;
    }
  }

  return null;
}

function areAllQuestionsAnswered(input: {
  questions: readonly Question[];
  selections: QuestionSelections;
  otherTexts: QuestionOtherTexts;
}): boolean {
  return input.questions.every((_, questionIndex) =>
    isQuestionAnswered({
      selections: input.selections,
      otherTexts: input.otherTexts,
      questionIndex,
    }),
  );
}

function buildQuestionAnswers(input: {
  questions: readonly Question[];
  selections: QuestionSelections;
  otherTexts: QuestionOtherTexts;
}): Record<string, string> {
  const answers: Record<string, string> = {};

  for (let questionIndex = 0; questionIndex < input.questions.length; questionIndex += 1) {
    const question = input.questions[questionIndex];
    if (!question) {
      continue;
    }

    const selected = input.selections[questionIndex];
    const otherText = input.otherTexts[questionIndex]?.trim();

    if (otherText && otherText.length > 0) {
      answers[question.header] = otherText;
      continue;
    }

    if (!selected || selected.size === 0) {
      continue;
    }

    const labels = Array.from(selected)
      .map((optionIndex) => question.options[optionIndex]?.label)
      .filter((label): label is string => typeof label === "string");
    if (labels.length > 0) {
      answers[question.header] = labels.join(", ");
    }
  }

  return answers;
}

function selectQuestionOption(input: {
  questions: readonly Question[];
  selections: QuestionSelections;
  otherTexts: QuestionOtherTexts;
  questionIndex: number;
  optionIndex: number;
}): {
  selections: QuestionSelections;
  otherTexts: QuestionOtherTexts;
} {
  const question = input.questions[input.questionIndex];
  if (!question || !question.options[input.optionIndex]) {
    return {
      selections: input.selections,
      otherTexts: input.otherTexts,
    };
  }

  const selections = cloneSelections(input.selections);
  const otherTexts = { ...input.otherTexts };
  const current = selections[input.questionIndex] ?? new Set<number>();
  const next = new Set(current);

  if (question.multiSelect) {
    if (next.has(input.optionIndex)) {
      next.delete(input.optionIndex);
    } else {
      next.add(input.optionIndex);
    }
  } else if (next.has(input.optionIndex)) {
    next.clear();
  } else {
    next.clear();
    next.add(input.optionIndex);
  }

  selections[input.questionIndex] = next;
  delete otherTexts[input.questionIndex];

  return { selections, otherTexts };
}

interface QuestionFormCardProps {
  permission: PendingPermission;
  onRespond: (response: AgentPermissionResponse) => void;
  isResponding: boolean;
  shortcutActive: boolean;
}

const IS_WEB = Platform.OS === "web";

export function QuestionFormCard({
  permission,
  onRespond,
  isResponding,
  shortcutActive,
}: QuestionFormCardProps) {
  const { theme } = useUnistyles();
  const isMobile = UnistylesRuntime.breakpoint === "xs" || UnistylesRuntime.breakpoint === "sm";
  const questions = parseQuestions(permission.request.input);

  const [selections, setSelections] = useState<QuestionSelections>({});
  const [otherTexts, setOtherTexts] = useState<QuestionOtherTexts>({});
  const [respondingAction, setRespondingAction] = useState<"submit" | "dismiss" | null>(null);

  const submitResponses = useCallback(
    (input: { selections: QuestionSelections; otherTexts: QuestionOtherTexts }) => {
      if (!questions) {
        return;
      }

      setRespondingAction("submit");
      onRespond({
        behavior: "allow",
        updatedInput: {
          ...permission.request.input,
          answers: buildQuestionAnswers({
            questions,
            selections: input.selections,
            otherTexts: input.otherTexts,
          }),
        },
      });
    },
    [onRespond, permission.request.input, questions],
  );

  const toggleOption = useCallback(
    (input: { questionIndex: number; optionIndex: number }) => {
      if (!questions) {
        return;
      }

      const next = selectQuestionOption({
        questions,
        selections,
        otherTexts,
        questionIndex: input.questionIndex,
        optionIndex: input.optionIndex,
      });
      setSelections(next.selections);
      setOtherTexts(next.otherTexts);
    },
    [otherTexts, questions, selections],
  );

  const setOtherText = useCallback((input: { questionIndex: number; text: string }) => {
    setOtherTexts((previous) => ({ ...previous, [input.questionIndex]: input.text }));
    if (input.text.length > 0) {
      setSelections((previous) => {
        if (!previous[input.questionIndex] || previous[input.questionIndex]?.size === 0) {
          return previous;
        }
        return { ...previous, [input.questionIndex]: new Set<number>() };
      });
    }
  }, []);

  const handleSubmit = useCallback(() => {
    submitResponses({ selections, otherTexts });
  }, [otherTexts, selections, submitResponses]);

  const handleDeny = useCallback(() => {
    setRespondingAction("dismiss");
    onRespond({
      behavior: "deny",
      message: "Dismissed by user",
    });
  }, [onRespond]);

  const handlePromptSelection = useCallback(
    (action: { id: string; index?: number }): boolean => {
      if (action.id !== "agent.prompt.select" || isResponding || !questions) {
        return false;
      }

      const questionIndex = findFirstUnansweredQuestionIndex({
        questions,
        selections,
        otherTexts,
      });
      if (questionIndex === null) {
        return false;
      }

      const optionIndex = (action.index ?? 0) - 1;
      const question = questions[questionIndex];
      if (!question?.options[optionIndex]) {
        return false;
      }

      const next = selectQuestionOption({
        questions,
        selections,
        otherTexts,
        questionIndex,
        optionIndex,
      });
      setSelections(next.selections);
      setOtherTexts(next.otherTexts);

      const shouldAutoSubmit =
        areAllQuestionsAnswered({
          questions,
          selections: next.selections,
          otherTexts: next.otherTexts,
        }) && questions.every((candidate) => candidate.multiSelect !== true);

      if (shouldAutoSubmit) {
        submitResponses(next);
      }

      return true;
    },
    [isResponding, otherTexts, questions, selections, submitResponses],
  );

  useKeyboardActionHandler({
    handlerId: `agent-prompt-question:${permission.key}`,
    actions: ["agent.prompt.select"],
    enabled: shortcutActive && !isResponding && questions !== null,
    priority: 150,
    handle: handlePromptSelection,
  });

  if (!questions) {
    return null;
  }

  const allAnswered = areAllQuestionsAnswered({
    questions,
    selections,
    otherTexts,
  });

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: theme.colors.surface1,
          borderColor: theme.colors.border,
        },
      ]}
    >
      {questions.map((question, questionIndex) => {
        const selected = selections[questionIndex] ?? new Set<number>();
        const otherText = otherTexts[questionIndex] ?? "";

        return (
          <View key={questionIndex} style={styles.questionBlock}>
            <View style={styles.questionHeader}>
              <Text style={[styles.questionText, { color: theme.colors.foreground }]}>
                {question.question}
              </Text>
              <CircleHelp size={14} color={theme.colors.foregroundMuted} />
            </View>
            <View style={styles.optionsWrap}>
              {question.options.map((option, optionIndex) => {
                const isSelected = selected.has(optionIndex);
                return (
                  <Pressable
                    key={optionIndex}
                    style={({ pressed, hovered = false }) => [
                      styles.optionItem,
                      (hovered || isSelected) && {
                        backgroundColor: theme.colors.surface2,
                      },
                      pressed && styles.optionItemPressed,
                    ]}
                    onPress={() =>
                      toggleOption({
                        questionIndex,
                        optionIndex,
                      })
                    }
                    disabled={isResponding}
                  >
                    <View style={styles.optionItemContent}>
                      <View style={styles.optionTextBlock}>
                        <Text style={[styles.optionLabel, { color: theme.colors.foreground }]}>
                          {option.label}
                        </Text>
                        {option.description ? (
                          <Text
                            style={[
                              styles.optionDescription,
                              { color: theme.colors.foregroundMuted },
                            ]}
                          >
                            {option.description}
                          </Text>
                        ) : null}
                      </View>
                      {isSelected ? (
                        <View style={styles.optionCheckSlot}>
                          <Check size={16} color={theme.colors.foregroundMuted} />
                        </View>
                      ) : null}
                    </View>
                  </Pressable>
                );
              })}
            </View>
            <TextInput
              style={[
                styles.otherInput,
                {
                  borderColor:
                    otherText.length > 0 ? theme.colors.borderAccent : theme.colors.border,
                  color: theme.colors.foreground,
                  backgroundColor: theme.colors.surface2,
                },
                // @ts-expect-error - outlineStyle is web-only
                IS_WEB && {
                  outlineStyle: "none",
                  outlineWidth: 0,
                  outlineColor: "transparent",
                },
              ]}
              placeholder="Other..."
              placeholderTextColor={theme.colors.foregroundMuted}
              value={otherText}
              onChangeText={(text) =>
                setOtherText({
                  questionIndex,
                  text,
                })
              }
              editable={!isResponding}
            />
          </View>
        );
      })}

      <View style={[styles.actionsContainer, !isMobile && styles.actionsContainerDesktop]}>
        <Pressable
          style={({ pressed, hovered = false }) => [
            styles.actionButton,
            {
              backgroundColor: hovered ? theme.colors.surface2 : theme.colors.surface1,
              borderColor: theme.colors.borderAccent,
            },
            pressed && styles.optionItemPressed,
          ]}
          onPress={handleDeny}
          disabled={isResponding}
        >
          {respondingAction === "dismiss" ? (
            <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
          ) : (
            <View style={styles.actionContent}>
              <X size={14} color={theme.colors.foregroundMuted} />
              <Text style={[styles.actionText, { color: theme.colors.foregroundMuted }]}>
                Dismiss
              </Text>
            </View>
          )}
        </Pressable>

        <Pressable
          style={({ pressed, hovered = false }) => {
            const disabled = !allAnswered || isResponding;
            return [
              styles.actionButton,
              {
                backgroundColor:
                  hovered && !disabled ? theme.colors.surface2 : theme.colors.surface1,
                borderColor: disabled ? theme.colors.border : theme.colors.borderAccent,
                opacity: disabled ? 0.5 : 1,
              },
              pressed && !disabled ? styles.optionItemPressed : null,
            ];
          }}
          onPress={handleSubmit}
          disabled={!allAnswered || isResponding}
        >
          {respondingAction === "submit" ? (
            <ActivityIndicator size="small" color={theme.colors.foreground} />
          ) : (
            <View style={styles.actionContent}>
              <Check
                size={14}
                color={allAnswered ? theme.colors.foreground : theme.colors.foregroundMuted}
              />
              <Text
                style={[
                  styles.actionText,
                  {
                    color: allAnswered ? theme.colors.foreground : theme.colors.foregroundMuted,
                  },
                ]}
              >
                Submit
              </Text>
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
  },
  questionText: {
    flex: 1,
    fontSize: theme.fontSize.base,
    lineHeight: 22,
  },
  optionsWrap: {
    gap: theme.spacing[1],
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
    alignItems: "center",
    gap: theme.spacing[2],
  },
  optionTextBlock: {
    flex: 1,
    gap: 2,
  },
  optionLabel: {
    fontSize: theme.fontSize.sm,
  },
  optionDescription: {
    fontSize: theme.fontSize.xs,
    lineHeight: 16,
  },
  optionCheckSlot: {
    width: 16,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: "auto",
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
