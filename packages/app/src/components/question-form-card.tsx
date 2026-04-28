import { useState, useCallback, useMemo } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  ActivityIndicator,
  type PressableStateCallbackType,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { Check, CircleHelp, X } from "lucide-react-native";
import type { PendingPermission } from "@/types/shared";
import type { AgentPermissionResponse } from "@server/server/agent/agent-sdk-types";
import { isWeb } from "@/constants/platform";

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
    if (typeof item !== "object" || item === null) return null;
    const q = item as Record<string, unknown>;
    if (typeof q.question !== "string" || typeof q.header !== "string") return null;
    if (!Array.isArray(q.options)) return null;
    const options: QuestionOption[] = [];
    for (const opt of q.options as unknown[]) {
      if (typeof opt !== "object" || opt === null) return null;
      const o = opt as Record<string, unknown>;
      if (typeof o.label !== "string") return null;
      options.push({
        label: o.label,
        description: typeof o.description === "string" ? o.description : undefined,
      });
    }
    questions.push({
      question: q.question,
      header: q.header,
      options,
      multiSelect: q.multiSelect === true,
    });
  }
  return questions.length > 0 ? questions : null;
}

interface QuestionFormCardProps {
  permission: PendingPermission;
  onRespond: (response: AgentPermissionResponse) => void;
  isResponding: boolean;
}

const IS_WEB = isWeb;

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

  const handlePress = useCallback(() => {
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

  const optionLabelStyle = useMemo(
    () => [styles.optionLabel, { color: theme.colors.foreground }],
    [theme.colors.foreground],
  );
  const optionDescriptionStyle = useMemo(
    () => [styles.optionDescription, { color: theme.colors.foregroundMuted }],
    [theme.colors.foregroundMuted],
  );

  return (
    <Pressable style={pressableStyle} onPress={handlePress} disabled={isResponding}>
      <View style={styles.optionItemContent}>
        <View style={styles.optionTextBlock}>
          <Text style={optionLabelStyle}>{option.label}</Text>
          {option.description ? (
            <Text style={optionDescriptionStyle}>{option.description}</Text>
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
}

interface QuestionOtherInputProps {
  qIndex: number;
  value: string;
  isResponding: boolean;
  onChange: (qIndex: number, text: string) => void;
  onSubmit: () => void;
}

function QuestionOtherInput({
  qIndex,
  value,
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
      placeholder="Other..."
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
  const isMobile = useIsCompactFormFactor();
  const questions = parseQuestions(permission.request.input);

  const [selections, setSelections] = useState<Record<number, Set<number>>>({});
  const [otherTexts, setOtherTexts] = useState<Record<number, string>>({});
  const [respondingAction, setRespondingAction] = useState<"submit" | "dismiss" | null>(null);

  const toggleOption = useCallback((qIndex: number, optIndex: number, multiSelect: boolean) => {
    setSelections((prev) => {
      const current = prev[qIndex] ?? new Set<number>();
      const next = new Set(current);
      if (multiSelect) {
        if (next.has(optIndex)) {
          next.delete(optIndex);
        } else {
          next.add(optIndex);
        }
      } else {
        if (next.has(optIndex)) {
          next.clear();
        } else {
          next.clear();
          next.add(optIndex);
        }
      }
      return { ...prev, [qIndex]: next };
    });
    setOtherTexts((prev) => {
      if (!prev[qIndex]) return prev;
      const next = { ...prev };
      delete next[qIndex];
      return next;
    });
  }, []);

  const setOtherText = useCallback((qIndex: number, text: string) => {
    setOtherTexts((prev) => ({ ...prev, [qIndex]: text }));
    if (text.length > 0) {
      setSelections((prev) => {
        if (!prev[qIndex] || prev[qIndex].size === 0) return prev;
        return { ...prev, [qIndex]: new Set<number>() };
      });
    }
  }, []);

  const allAnswered =
    questions?.every((_, qIndex) => {
      const selected = selections[qIndex];
      const otherText = otherTexts[qIndex]?.trim();
      return (selected && selected.size > 0) || (otherText && otherText.length > 0);
    }) ?? false;

  const handleSubmit = useCallback(() => {
    if (!questions || !allAnswered || isResponding) return;
    setRespondingAction("submit");
    const answers: Record<string, string> = {};
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const selected = selections[i];
      const otherText = otherTexts[i]?.trim();

      if (otherText && otherText.length > 0) {
        answers[q.header] = otherText;
      } else if (selected && selected.size > 0) {
        const labels = Array.from(selected).map((idx) => q.options[idx].label);
        answers[q.header] = labels.join(", ");
      }
    }

    onRespond({
      behavior: "allow",
      updatedInput: { ...permission.request.input, answers },
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
    setRespondingAction("dismiss");
    onRespond({
      behavior: "deny",
      message: "Dismissed by user",
    });
  }, [onRespond]);

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

  const submitDisabled = !allAnswered || isResponding;
  const submitButtonStyle = useCallback(
    ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.actionButton,
      {
        backgroundColor: hovered && !submitDisabled ? theme.colors.surface2 : theme.colors.surface1,
        borderColor: submitDisabled ? theme.colors.border : theme.colors.borderAccent,
        opacity: submitDisabled ? 0.5 : 1,
      },
      pressed && !submitDisabled ? styles.optionItemPressed : null,
    ],
    [
      submitDisabled,
      theme.colors.surface2,
      theme.colors.surface1,
      theme.colors.border,
      theme.colors.borderAccent,
    ],
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
  const actionsContainerStyle = useMemo(
    () => [styles.actionsContainer, !isMobile && styles.actionsContainerDesktop],
    [isMobile],
  );
  const dismissActionTextStyle = useMemo(
    () => [styles.actionText, { color: theme.colors.foregroundMuted }],
    [theme.colors.foregroundMuted],
  );
  const submitActionTextColor = allAnswered
    ? theme.colors.foreground
    : theme.colors.foregroundMuted;
  const submitActionTextStyle = useMemo(
    () => [styles.actionText, { color: submitActionTextColor }],
    [submitActionTextColor],
  );

  if (!questions) {
    return null;
  }

  return (
    <View style={containerStyle}>
      {questions.map((q, qIndex) => {
        const selected = selections[qIndex] ?? new Set<number>();
        const otherText = otherTexts[qIndex] ?? "";

        return (
          <View key={q.question} style={styles.questionBlock}>
            <View style={styles.questionHeader}>
              <Text style={questionTextStyle}>{q.question}</Text>
              <CircleHelp size={14} color={theme.colors.foregroundMuted} />
            </View>
            <View style={styles.optionsWrap}>
              {q.options.map((opt, optIndex) => (
                <QuestionOptionRow
                  key={opt.label}
                  qIndex={qIndex}
                  optIndex={optIndex}
                  option={opt}
                  isSelected={selected.has(optIndex)}
                  multiSelect={q.multiSelect}
                  isResponding={isResponding}
                  onToggle={toggleOption}
                />
              ))}
            </View>
            <QuestionOtherInput
              qIndex={qIndex}
              value={otherText}
              isResponding={isResponding}
              onChange={setOtherText}
              onSubmit={handleSubmit}
            />
          </View>
        );
      })}

      <View style={actionsContainerStyle}>
        <Pressable style={dismissButtonStyle} onPress={handleDeny} disabled={isResponding}>
          {respondingAction === "dismiss" ? (
            <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
          ) : (
            <View style={styles.actionContent}>
              <X size={14} color={theme.colors.foregroundMuted} />
              <Text style={dismissActionTextStyle}>Dismiss</Text>
            </View>
          )}
        </Pressable>

        <Pressable style={submitButtonStyle} onPress={handleSubmit} disabled={submitDisabled}>
          {respondingAction === "submit" ? (
            <ActivityIndicator size="small" color={theme.colors.foreground} />
          ) : (
            <View style={styles.actionContent}>
              <Check size={14} color={submitActionTextColor} />
              <Text style={submitActionTextStyle}>Submit</Text>
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
